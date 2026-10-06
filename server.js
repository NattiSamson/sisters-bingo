/**
 * Beteseb Bingo — Server v5
 * Changes:
 *  - 80% winner / 20% house cut
 *  - Disqualification only notifies the cheater (silent to others)
 *  - Admin page (phone 251934255415 → admin)
 *  - Deposit/withdrawal requests with approve/reject
 *  - Full DB integration
 this is zola
 */

require('dotenv').config();
const crypto=require('crypto');

// Fair random pick for the number draw: an unbiased integer in [0, n) from the operating system's
// cryptographic random generator (not Math.random, whose internal state can be reconstructed from its output).
function randomIndex(n){
  n=Math.max(1,Math.floor(Number(n)||1));
  if(typeof crypto.randomInt==='function') return crypto.randomInt(n);       // Node 14.10+
  const limit=Math.floor(0x100000000/n)*n;                                   // older Node: rejection sampling, no modulo bias
  let x; do{ x=crypto.randomBytes(4).readUInt32BE(0); }while(x>=limit);
  return x%n;
}

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path      = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const PORT   = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use('/audio', express.static(path.join(__dirname, 'audio')));
app.use(express.json());
app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const ADMIN_PHONE = '251965666656';
function isAdminPhone(phone) {
  if (!phone) return false;
  const normalized = String(phone).replace(/^\+/, '');
  return normalized === ADMIN_PHONE;
}
const HOUSE_CUT   = 0.20; // 20% house, 80% winner
// Prize pool that players actually see/win — total pot minus house cut
function prizePoolOf(room){ return Math.floor(room.pot*(1-HOUSE_CUT)); }
// NOTE: room.pot is ALREADY the prize pool (gross pot minus the 20% house cut, see startGame).
// Never pass it through prizePoolOf() again, or the cut is applied twice.
// "Players" shown in the game = players who paid and are in this round (spectators excluded),
// so players and spectators always see the same number.
function paidPlayersOf(room){ return room.players.filter(p=>p.hasPaid); }
function livePlayerCount(room){ return paidPlayersOf(room).length; }
function paidPlayerList(room){ return paidPlayersOf(room).map(p=>({playerId:p.playerId,playerName:p.playerName})); }

// ─── PAYMENT INFO (admin-editable) ─────────────────────────────
let PAYMENT_INFO = { telebirrNumber: '0967423275', telebirrName: 'Lidetua' };

// ─── DATABASE ─────────────────────────────────────────────────
let db = null;
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 20,                      // cap concurrent DB connections
      idleTimeoutMillis: 30000,     // close idle connections after 30s
      connectionTimeoutMillis: 5000 // fail fast instead of hanging under load
    });
    // Optional migration route. The game server does not depend on this file.
    // If migrate-route.js is not present on shared hosting, keep the DB/game
    // server running normally instead of making db initialization fail.
    try {
      const { registerMigrateRoute } = require('./migrate-route');
      registerMigrateRoute(app, pool);
    } catch (e) {
      console.warn('migrate-route.js not loaded (optional):', e.message);
    }

    db = {
      q: (sql, p) => pool.query(sql, p).then(r => r.rows),

      async getUser(tid) {
        const r = await this.q('SELECT * FROM users WHERE telegram_id=$1', [String(tid)]);
        return r[0] || null;
      },
      async getUserByPhone(phone) {
        const r = await this.q('SELECT * FROM users WHERE phone=$1', [phone]);
        return r[0] || null;
      },
      async createUser(tid, name, phone) {
        const r = await this.q(
          `INSERT INTO users(telegram_id,name,phone,balance) VALUES($1,$2,$3,0)
           ON CONFLICT(telegram_id) DO UPDATE SET last_seen=NOW() RETURNING *`,
          [String(tid), name, phone]
        );
        return r[0];
      },
      async setBalance(tid, bal) {
        await this.q('UPDATE users SET balance=$1 WHERE telegram_id=$2', [bal, String(tid)]);
      },
      // Atomic balance change. This is the only method used by game money
      // operations, so two simultaneous requests cannot overwrite each other.
      async adjustBalance(tid, delta) {
        const amount = Number(delta);
        if(!Number.isFinite(amount)) throw new Error('Invalid balance adjustment');

        const id = String(tid).trim();
        if(!id) {
          const e = new Error('Missing Telegram ID');
          e.code = 'NO_TELEGRAM_ID';
          throw e;
        }

        // IMPORTANT: use the exact Telegram ID stored in Neon and perform the
        // debit atomically.  We return the real current balance on an
        // insufficient-funds failure instead of treating every failed UPDATE
        // as "Need 10 ETB".
        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          const r = await client.query(
            `SELECT balance
               FROM users
              WHERE telegram_id = $1
              FOR UPDATE`,
            [id]
          );

          if(!r.rows[0]){
            await client.query('ROLLBACK');
            const e = new Error('Account not found');
            e.code = 'ACCOUNT_NOT_FOUND';
            throw e;
          }

          const current = Number.parseFloat(r.rows[0].balance) || 0;

          if(current + amount < 0){
            await client.query('ROLLBACK');
            const e = new Error('Insufficient balance');
            e.code = 'INSUFFICIENT_BALANCE';
            e.balance = current;
            throw e;
          }

          const updated = await client.query(
            `UPDATE users
                SET balance = balance + $2
              WHERE telegram_id = $1
              RETURNING balance`,
            [id, amount]
          );

          if(!updated.rows[0]){
            await client.query('ROLLBACK');
            const e = new Error('Balance update failed');
            e.code = 'BALANCE_UPDATE_FAILED';
            throw e;
          }

          const newBalance = Number.parseFloat(updated.rows[0].balance) || 0;

          await client.query('COMMIT');
          return newBalance;
        }catch(e){
          try { await client.query('ROLLBACK'); } catch(_){}
          throw e;
        }finally{
          client.release();
        }
      },
      async logTx(tid, type, amount, balAfter, ref) {
        await this.q(
          `INSERT INTO transactions(user_id,type,amount,balance_after,reference)
           SELECT id,$2,$3,$4,$5 FROM users WHERE telegram_id=$1`,
          [String(tid), type, amount, balAfter, ref || '']
        );
      },
      async saveGame(roomId, stakeId, amount, pot) {
        const r = await this.q(
          `INSERT INTO games(room_id,stake_id,stake_amount,pot,status,started_at)
           VALUES($1,$2,$3,$4,'playing',NOW()) RETURNING id`,
          [roomId, stakeId, amount, pot]
        );
        return r[0].id;
      },
      async endGame(gameId, tids, winAmount, isSplit, called) {
        await this.q(
          `UPDATE games SET status='finished',winner_ids=$1,win_amount=$2,is_split=$3,called_numbers=$4,ended_at=NOW() WHERE id=$5`,
          [tids, winAmount, isSplit, called, gameId]
        );
        if (tids.length) {
          await this.q('UPDATE users SET total_wins=total_wins+1,total_winnings=total_winnings+$1 WHERE telegram_id=ANY($2)', [winAmount, tids]);
        }
        await this.q(`UPDATE users SET total_games=total_games+1 WHERE telegram_id=ANY(
          SELECT DISTINCT u.telegram_id FROM game_participants gp JOIN users u ON u.id=gp.user_id WHERE gp.game_id=$1)`, [gameId]);
      },
      async getGameHistory(tid, limit=50) {
        // The existing stake transactions use the game room_id as their reference.
        // Use those transactions to link this Telegram user to finished games, so
        // history works with the current database without changing the schema.
        return this.q(
          `SELECT
             g.id, g.stake_id, g.stake_amount, g.pot, g.win_amount,
             g.status, g.started_at, g.ended_at,
             COALESCE(SUM(ABS(t.amount)) FILTER (WHERE t.type='stake'),0)::numeric AS amount_played,
             COALESCE(SUM(t.amount) FILTER (WHERE t.type='win'),0)::numeric AS amount_won,
             CASE WHEN $1 = ANY(COALESCE(g.winner_ids, ARRAY[]::text[])) THEN true ELSE false END AS won
           FROM games g
           JOIN transactions t ON t.reference=g.room_id
           JOIN users u ON u.id=t.user_id
           WHERE u.telegram_id=$1
             AND g.status='finished'
             AND t.type IN ('stake','win')
           GROUP BY g.id, g.stake_id, g.stake_amount, g.pot, g.win_amount,
                    g.status, g.started_at, g.ended_at, g.winner_ids
           ORDER BY g.started_at DESC
           LIMIT $2`,
          [String(tid), Math.min(Math.max(Number(limit)||50,1),100)]
        );
      },

      // ── Deposits ──
      async createDeposit(tid, amount, txRef) {
        const r = await this.q(
          `INSERT INTO deposit_requests(user_id,amount,tx_ref,status)
           SELECT id,$2,$3,'pending' FROM users WHERE telegram_id=$1 RETURNING id`,
          [String(tid), amount, txRef]
        );
        return r[0]?.id;
      },
      async getDeposits(status) {
        const where = status ? 'WHERE dr.status=$1' : '';
        const params = status ? [status] : [];
        return this.q(
          `SELECT dr.*,u.name,u.phone,u.telegram_id FROM deposit_requests dr
           JOIN users u ON u.id=dr.user_id ${where} ORDER BY dr.created_at DESC LIMIT 50`, params
        );
      },
      async approveDeposit(id) {
        const r = await this.q(
          `UPDATE deposit_requests SET status='approved',handled_at=NOW() WHERE id=$1 AND status='pending' RETURNING *`, [id]
        );
        if (!r[0]) return null;
        const dep = r[0];
        // Credit atomically so a simultaneous game charge cannot overwrite it.
        const u = await this.q('SELECT telegram_id FROM users WHERE id=$1', [dep.user_id]);
        if (u[0]) {
          const newBal = await this.adjustBalance(u[0].telegram_id, parseFloat(dep.amount));
          if(newBal===null) return null;
          await this.logTx(u[0].telegram_id, 'deposit', dep.amount, newBal, dep.tx_ref);
          return { telegramId: u[0].telegram_id, newBalance: newBal, amount: dep.amount };
        }
        return null;
      },
      async rejectDeposit(id) {
        await this.q(`UPDATE deposit_requests SET status='rejected',handled_at=NOW() WHERE id=$1`, [id]);
      },

      // ── Withdrawals ──
      async createWithdrawal(tid, amount) {
        const r = await this.q(
          `WITH debited AS (
             UPDATE users
             SET balance=balance-$2
             WHERE telegram_id=$1 AND balance >= $2
             RETURNING id,telegram_id,balance
           )
           INSERT INTO withdrawal_requests(user_id,amount,status)
           SELECT id,$2,'pending' FROM debited
           RETURNING id, (SELECT balance FROM debited) AS new_balance`,
          [String(tid), amount]
        );
        if(!r[0]) return { error:'Insufficient balance' };
        const newBal=parseFloat(r[0].new_balance);
        await this.logTx(tid,'withdrawal_pending',-amount,newBal,'pending');
        return { id:r[0].id, newBalance:newBal };
      },
      async getWithdrawals(status) {
        const where = status ? 'WHERE wr.status=$1' : '';
        const params = status ? [status] : [];
        return this.q(
          `SELECT wr.*,u.name,u.phone,u.telegram_id FROM withdrawal_requests wr
           JOIN users u ON u.id=wr.user_id ${where} ORDER BY wr.created_at DESC LIMIT 50`, params
        );
      },
      async approveWithdrawal(id) {
        const r = await this.q(
          `UPDATE withdrawal_requests SET status='approved',handled_at=NOW() WHERE id=$1 AND status='pending' RETURNING *`, [id]
        );
        if (!r[0]) return null;
        const wr = r[0];
        const u = await this.q('SELECT telegram_id FROM users WHERE id=$1', [wr.user_id]);
        if (u[0]) await this.logTx(u[0].telegram_id, 'withdrawal', -wr.amount, 0, 'approved');
        return { telegramId: u[0]?.telegram_id, amount: wr.amount };
      },
      async rejectWithdrawal(id) {
        // Refund the balance
        const r = await this.q(
          `UPDATE withdrawal_requests SET status='rejected',handled_at=NOW() WHERE id=$1 AND status='pending' RETURNING *`, [id]
        );
        if (!r[0]) return null;
        const wr = r[0];
        const u = await this.q('SELECT telegram_id FROM users WHERE id=$1', [wr.user_id]);
        if (u[0]) {
          const newBal = await this.adjustBalance(u[0].telegram_id, parseFloat(wr.amount));
          if(newBal===null) return null;
          await this.logTx(u[0].telegram_id, 'withdrawal_refund', wr.amount, newBal, 'rejected');
          return { telegramId: u[0].telegram_id, newBalance: newBal };
        }
        return null;
      },

      // ── Admin user search ──
      async searchByPhone(phone) {
        return this.q(
          `SELECT u.*,
            (SELECT json_agg(t ORDER BY t.created_at DESC) FROM transactions t WHERE t.user_id=u.id) as transactions,
            (SELECT COUNT(*) FROM game_participants gp WHERE gp.user_id=u.id) as games_played
           FROM users u WHERE u.phone LIKE $1 LIMIT 10`,
          ['%' + phone + '%']
        );
      },

      async getLeaderboard() {
        return this.q('SELECT name,total_wins,total_games,total_winnings FROM users ORDER BY total_winnings DESC LIMIT 10');
      },

      // ── Settings (key/value store) ──
      async ensureSettingsTable() {
        await this.q(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
      },
      async getSetting(key) {
        const r = await this.q('SELECT value FROM settings WHERE key=$1', [key]);
        return r[0]?.value;
      },
      async setSetting(key, value) {
        await this.q(
          `INSERT INTO settings(key,value) VALUES($1,$2)
           ON CONFLICT(key) DO UPDATE SET value=$2`,
          [key, value]
        );
      }
    };

    pool.query('SELECT 1').then(async () => {
      console.log('✅ PostgreSQL connected');
      try {
        await db.ensureSettingsTable();
        const num  = await db.getSetting('telebirr_number');
        const name = await db.getSetting('telebirr_name');
        if (num)  PAYMENT_INFO.telebirrNumber = num;
        if (name) PAYMENT_INFO.telebirrName   = name;
      } catch (e) { console.error('⚠️ Settings load:', e.message); }

      // Clean up any games left in 'playing' state from a previous crashed session (legacy schema only)
      if(!USE_BINGO_DB) try {
        const stale = await db.q(
          `UPDATE games SET status='finished', ended_at=NOW(), win_amount=0
           WHERE status='playing' AND started_at < NOW() - INTERVAL '2 hours'
           RETURNING id`
        );
        if(stale.length) console.log(`🧹 Cleaned up ${stale.length} stale playing game(s):`, stale.map(r=>r.id));
      } catch(e) { console.error('⚠️ Stale game cleanup:', e.message); }
    }).catch(e => { console.error('❌ DB:', e.message); db = null; });
  } catch(e) { console.log('⚠️ pg error:', e.message); }
} else {
  console.log('ℹ️ No DATABASE_URL — memory mode');
}

// ─── BINGO DATABASE (db.js) ──────────────────────────────────
// db.js talks to the real wallet / room / stake / game tables:
//   getUserWalletBalances -> main + play + bonus wallets
//   getActiveStakes       -> rooms and stakes (loaded ONCE, refreshed every 10 min)
//   createBingoGame       -> charges every cartela and creates the game (called when a round starts)
//   endBingoGame          -> pays the winners (called when a round ends)
//   getBingoUserDashboard -> profile page data
// If db.js cannot be loaded the server falls back to the old in-file database code.
let bingoDb=null;
if(process.env.DATABASE_URL){
  try{ bingoDb=require('./db'); console.log('✅ db.js loaded (wallets, stakes, bingo games)'); }
  catch(e){ console.error('⚠️ db.js could not be loaded, legacy balance code stays active:',e.message); }
}
const USE_BINGO_DB=!!bingoDb;

// ─── CONFIG ──────────────────────────────────────────────────
const LOBBY_WAIT_MS    = 30000;
const CALL_INTERVAL_MS = 5000;
const CLAIM_WINDOW_MS  = 4800;
const CLAIM_COLLECT_MS = 700; // grace period to gather simultaneous BINGO claims
const TOTAL_CARDS      = 600;   // largest card_count a room may use (your rooms use 600)

const STAKES = [
  { id:'st5',  amount:5,  maxPlayers:400, cardLimit:400 },
  { id:'st10', amount:10, maxPlayers:400, cardLimit:400 },
  { id:'st20', amount:20, maxPlayers:400, cardLimit:400 },
];
// With db.js the stakes come ONLY from the database (bingo_stakes / bingo_rooms); the list above is used only without a database.
if(USE_BINGO_DB) STAKES.length=0;
const STAKES_RETRY_MS = 10000;
let stakesRetryTimer=null;
function retryStakesSoon(){ if(stakesRetryTimer||STAKES.length) return; stakesRetryTimer=setTimeout(()=>{ stakesRetryTimer=null; loadStakesFromDb(); },STAKES_RETRY_MS); }

// Stakes / rooms come from the database (bingo_stakes + bingo_rooms). They are loaded ONCE at
// start-up and refreshed every 10 minutes; the constants above are only the fallback.
// The app names a stake by its amount (st5, st10, st20); the database's own id (S5, S10, ...) is kept in dbStakeId.
const stakeKey=a=>'st'+(Number.isInteger(Number(a))?Number(a):String(a).replace('.','p'));
async function loadStakesFromDb(){
  if(!bingoDb) return false;
  try{
    const list=await bingoDb.getActiveStakes();
    const seen=new Set(), next=[];
    for(const s of list){
      if(seen.has(stakeKey(s.amount))) continue;   // one room per stake
      seen.add(stakeKey(s.amount));
      next.push({
        id:stakeKey(s.amount), dbStakeId:s.dbId, dbRoomId:s.roomId, name:s.displayName||s.name,
        amount:s.amount,
        maxPlayers:s.maxPlayers||400,
        cardLimit:Math.max(1,Math.min(TOTAL_CARDS,s.cardCount||TOTAL_CARDS)),
        minPlayers:Math.max(2,s.minPlayers||2),
        maxCards:Math.max(1,Math.min(4,s.maxCardsPerPlayer||4)),
        selectionSeconds:s.selectionSeconds||Math.ceil(LOBBY_WAIT_MS/1000)
      });
    }
    if(!next.length){ console.warn('⚠️ getActiveStakes returned no active stakes (bingo_stakes + bingo_room_stakes + bingo_rooms must be active)'); retryStakesSoon(); return false; }
    STAKES.splice(0,STAKES.length,...next);
    console.log('✅ Stakes loaded from database:',next.map(x=>`${x.id}=${x.amount} (room ${x.dbRoomId}, ${x.minPlayers}-${x.maxPlayers} players, ${x.maxCards} cards)`).join(' | '));
    broadcastLobby();
    return true;
  }catch(e){ console.error('loadStakesFromDb:',e.message); retryStakesSoon(); return false; }
}

if(bingoDb){
  loadStakesFromDb(); loadFundingWallets();
  setInterval(()=>{ loadStakesFromDb(); loadFundingWallets(); },10*60*1000);
  // clean up games left open by an earlier run (restart / crash); young ones are left alone
  setTimeout(()=>recoverOrphanedGames({minAgeSec:600,reason:'startup_cleanup'}),20*1000);
  setInterval(()=>recoverOrphanedGames({minAgeSec:900,reason:'stale_game'}),10*60*1000);
}

// ─── FIXED CARDS ─────────────────────────────────────────────
function seededRandom(seed) {
  let s = seed;
  return () => { s|=0; s=s+0x6D2B79F5|0; let t=Math.imul(s^s>>>15,1|s); t=t+Math.imul(t^t>>>7,61|t)^t; return((t^t>>>14)>>>0)/4294967296; };
}
function generateFixedCard(idx) {
  const rng=seededRandom(idx*7919), ranges=[[1,15],[16,30],[31,45],[46,60],[61,75]], nums=Array(25).fill(0);
  for(let col=0;col<5;col++){
    const[lo,hi]=ranges[col], pool=Array.from({length:hi-lo+1},(_,i)=>lo+i), picked=[];
    for(let i=0;i<5;i++){const j=Math.floor(rng()*pool.length);picked.push(pool.splice(j,1)[0]);}
    picked.sort((a,b)=>a-b);
    for(let row=0;row<5;row++){const ci=row*5+col; nums[ci]=ci===12?0:picked[row];}
  }
  return nums;
}
const CARD_POOL=[];
for(let i=1;i<=TOTAL_CARDS;i++) CARD_POOL.push({id:i,numbers:generateFixedCard(i)});
const getCard=id=>CARD_POOL.find(c=>c.id===id);
const getCardPoolForRoom=room=>CARD_POOL.slice(0,Math.min(TOTAL_CARDS,Number(room?.cardLimit)||TOTAL_CARDS));

// ─── WIN CHECK ───────────────────────────────────────────────
function checkWin(nums, called, marked) {
  const cs=new Set(called), ms=new Set(marked||[]); ms.add(12);
  const hit=i=>i===12||(cs.has(nums[i])&&ms.has(i));
  return [[0,1,2,3,4],[5,6,7,8,9],[10,11,12,13,14],[15,16,17,18,19],[20,21,22,23,24],
          [0,5,10,15,20],[1,6,11,16,21],[2,7,12,17,22],[3,8,13,18,23],[4,9,14,19,24],
          [0,6,12,18,24],[4,8,12,16,20],[0,4,20,24]].some(p=>p.every(i=>hit(i)));
}

// ─── STATE ───────────────────────────────────────────────────
const clients={}, rooms={}, userCache={};

// ─── USER HELPERS ────────────────────────────────────────────
const round2=v=>Math.round((Number(v)||0)*100)/100;
function walletsFromRow(r){
  const n=v=>{const x=Number.parseFloat(v);return Number.isFinite(x)&&x>0?x:0;};
  return {main:n(r.main_balance),play:n(r.play_balance),bonus:n(r.bonus_balance)};
}
// Wallets the stake funding policy may charge, in order (read once from the database; refreshed with the stakes).
// place_stake() only counts these wallets, so a wallet that is not in the list cannot pay for a cartela.
let FUNDING_WALLETS=['main','play','bonus'];
async function loadFundingWallets(){
  if(!bingoDb||typeof bingoDb.getBingoFundingWallets!=='function') return false;
  try{
    const list=(await bingoDb.getBingoFundingWallets()).filter(x=>['main','play','bonus'].includes(x));
    if(!list.length){ console.warn('⚠️ the stake funding policy lists no wallets - keeping the default'); return false; }
    FUNDING_WALLETS=list;
    console.log('✅ Stakes are paid from:',list.join(' -> '));
    return true;
  }catch(e){ console.error('loadFundingWallets:',e.message); return false; }
}
// balance   = main + play   (the amount shown in the header)
// spendable = the wallets the funding policy can charge (fast local check before picking cartelas;
//             the database makes the final call)
function applyWallets(target,w){
  target.wallets={main:round2(w.main),play:round2(w.play),bonus:round2(w.bonus)};
  target.balance=round2(w.main+w.play);
  target.spendable=round2(FUNDING_WALLETS.reduce((t,k)=>t+(Number(w[k])||0),0));
}
// Cached per-user profile answers (a game start/end clears the entry)
const profileCache=new Map();
const PROFILE_TTL_MS=10000;

async function loadUser(tid,retries=6,delayMs=500) {
  const id=String(tid||'').trim();
  if(!/^\d+$/.test(id) || Number(id)<=0) return null;

  // ── Real wallets (db.js) ──
  if(USE_BINGO_DB){
    for(let attempt=1;attempt<=retries;attempt++){
      try{
        const r=await bingoDb.getUserWalletBalances(id);
        if(!r) return null;                      // genuinely not registered
        const prev=userCache[id]||{};
        const phone=r.phone||'';
        const u={
          userId:Number(r.user_id), name:r.name||'', phone,
          isAdmin:isAdminPhone(phone)||prev.isAdmin===true
        };
        applyWallets(u,walletsFromRow(r));
        // admin / blocked flags are looked up once per user, not on every refresh
        if(prev.flagsChecked){
          u.flagsChecked=true; u.isAdmin=u.isAdmin||prev.isAdmin===true; u.blocked=prev.blocked===true; u.inactive=prev.inactive===true;
        }else{
          try{
            const f=await bingoDb.getBingoUserFlags(id);
            if(f){ u.isAdmin=u.isAdmin||f.is_admin===true; u.blocked=f.is_blocked===true; u.inactive=f.is_active===false; }
          }catch(e){ console.error('getBingoUserFlags:',e.message); }
          u.flagsChecked=true;
        }
        userCache[id]=u;
        return u;
      }catch(e){
        console.error(`loadUser attempt ${attempt}/${retries}:`,e.message);
        if(attempt<retries) await new Promise(r=>setTimeout(r,delayMs*Math.min(attempt,3)));
      }
    }
    return userCache[id]||null;
  }

  // ── Legacy single-balance schema ──
  if(!db) return null;
  for(let attempt=1;attempt<=retries;attempt++){
    try{
      const u=await db.getUser(id);
      if(u){
        const balance=Number.parseFloat(u.balance);
        userCache[id] = {
          name:u.name||'',
          phone:u.phone||'',
          balance:Number.isFinite(balance)?balance:0,
          isAdmin:u.is_admin===true
        };
        return userCache[id];
      }
      return null;
    }catch(e){
      console.error(`loadUser attempt ${attempt}/${retries}:`,e.message);
      if(attempt<retries) await new Promise(r=>setTimeout(r,delayMs*Math.min(attempt,3)));
    }
  }
  return userCache[id]||null;
}

// copy a loaded user onto a live connection
function applyUserToClient(client,u){
  if(!client||!u) return;
  if(u.wallets){ client.wallets=u.wallets; client.spendable=u.spendable; }
  client.balance=Number.isFinite(Number(u.balance))?Number(u.balance):0;
  if(u.userId) client.userId=u.userId;
  client.playerName=u.name||client.playerName;
  client.isAdmin=u.isAdmin===true || isAdminPhone(u.phone);
}

async function refreshClientBalance(client){
  if(!client?.telegramId) return Number.isFinite(Number(client?.balance));
  try{
    if(USE_BINGO_DB){
      const u=await loadUser(String(client.telegramId),1,0);
      if(!u) return false;
      applyUserToClient(client,u);
      return true;
    }
    if(!db) return Number.isFinite(Number(client?.balance));
    const u=await db.getUser(String(client.telegramId));
    if(!u) return false;
    client.balance=parseFloat(u.balance)||0;
    client.playerName=u.name||client.playerName;
    client.isAdmin=u.is_admin===true || isAdminPhone(u.phone);
    if(userCache[client.telegramId]) userCache[client.telegramId].balance=client.balance;
    return true;
  }catch(e){
    console.error('refreshClientBalance:',e.message);
    return false;
  }
}

// Reload a player's wallets once and push them to the app (after a round starts / ends).
async function pushWallets(p){
  const tid=String(p?.telegramId||'');
  if(!tid) return;
  profileCache.delete(tid);
  const u=await loadUser(tid,1,0);
  if(!u) return;
  const cl=clients[p.playerId];
  if(cl) applyUserToClient(cl,u);
  send(p.ws||cl?.ws,{type:'balanceUpdate',balance:u.balance,wallets:u.wallets});
}
// run an async function over a list with a small concurrency limit (protects the DB pool)
async function forEachLimit(items,limit,fn){
  let i=0;
  const workers=Array.from({length:Math.min(limit,items.length)},async()=>{
    while(i<items.length){ const item=items[i++]; try{ await fn(item); }catch(e){ console.error('forEachLimit:',e.message); } }
  });
  await Promise.all(workers);
}

// Change money atomically and mirror the resulting balance in memory.
// Positive delta = credit/refund; negative delta = charge.
// With db.js ALL game money moves through createBingoGame / endBingoGame, so direct changes are refused.
async function changeClientBalance(client, delta, txType, ref){
  const amount=Number(delta);
  if(!client || !Number.isFinite(amount)) throw new Error('Invalid balance change');

  if(USE_BINGO_DB){
    const e=new Error('Direct balance changes are disabled: wallets are handled by the database functions');
    e.code='DIRECT_BALANCE_DISABLED';
    throw e;
  }

  if(!client.telegramId){
    const e=new Error('Missing Telegram ID');
    e.code='NO_TELEGRAM_ID';
    throw e;
  }

  if(db){
    const newBal=await db.adjustBalance(String(client.telegramId),amount);
    client.balance=newBal;
    if(userCache[client.telegramId])
      userCache[client.telegramId].balance=newBal;
    if(txType){
      try{
        await db.logTx(String(client.telegramId),txType,amount,newBal,ref||'');
      }catch(e){
        console.error('logTx:',e.message);
      }
    }
    return newBal;
  }

  // Only used when DB is genuinely unavailable.
  const current=Number(client.balance)||0;
  const next=current+amount;
  if(next<0){
    const e=new Error('Insufficient balance');
    e.code='INSUFFICIENT_BALANCE';
    e.balance=current;
    throw e;
  }
  client.balance=next;
  return next;
}

async function saveBalance(tid, bal) {
  // Kept for non-game compatibility. Game money paths use createBingoGame / endBingoGame.
  if(userCache[tid]) userCache[tid].balance=bal;
  if(!USE_BINGO_DB && db&&tid){try{await db.setBalance(tid,bal);}catch(e){console.error('saveBalance:',e.message);}}
}

// ─── ROOM HELPERS ────────────────────────────────────────────
function getOrCreateRoom(sid){
  let r=Object.values(rooms).find(r=>r.stakeId===sid&&(r.status==='waiting'||r.status==='countdown'));
  if(r) return r;
  const s=STAKES.find(s=>s.id===sid), roomId=uuidv4();
  r={roomId,stakeId:sid,stake:s.amount,maxPlayers:s.maxPlayers,cardLimit:s.cardLimit,
     dbStakeId:s.dbStakeId||null,dbRoomId:s.dbRoomId||null,minPlayers:s.minPlayers||2,maxCards:s.maxCards||4,selectionSeconds:s.selectionSeconds||0,
     status:'waiting',players:[],calledNumbers:[],
     availableNumbers:Array.from({length:75},(_,i)=>i+1),callTimer:null,countdownTimer:null,claimEvalTimer:null,
     countdownLeft:Math.ceil((s.selectionSeconds?s.selectionSeconds*1000:LOBBY_WAIT_MS)/1000),claimWindowOpen:false,claimedThisRound:[],resetCountdownTimer:null,resetTimer:null,
     takenCardIds:new Set(),pot:0,grossPot:0,dbGameId:null,dbGameCode:null,participantCards:null,startFailures:0};
  rooms[roomId]=r; return r;
}
const send=(ws,msg)=>{
  if(!ws||ws.readyState!==WebSocket.OPEN) return;
  // every message about a running game carries the game code returned by createBingoGame (shown as "Game ID")
  if(msg&&msg.roomId&&msg.gameId===undefined){ const r=rooms[msg.roomId]; if(r&&r.dbGameCode) msg={...msg,gameId:r.dbGameCode}; }
  ws.send(JSON.stringify(msg));
};
// A player can be in SEVERAL rooms at once (one per stake: 5 / 10 / 20 = up to 3 games at a time).
// Every room message carries roomId + stakeId so the app can handle each game separately.
const sendRoom=(room,ws,msg)=>send(ws,{roomId:room.roomId,stakeId:room.stakeId,...msg});
// How long a player who lost his connection before the round starts keeps his seat and cartelas.
// (A page "Refresh" closes and re-opens the connection; the player must not lose his picks.)
const DISCONNECT_GRACE_MS = 20000;

// ── One account = one player, on any number of devices ───────────────────────
// A player's `ws` is a small multiplexer that holds every open connection (device) of that account,
// so every message sent to the player reaches all of his devices and they always show the same state.
function makeMux(initial){
  const socks=new Set(initial||[]);
  return {
    sockets:socks,
    get readyState(){ for(const x of socks) if(x&&x.readyState===1) return 1; return 3; },
    send(data){ for(const x of socks){ if(x&&x.readyState===1){ try{ x.send(data); }catch(e){} } } }
  };
}
function attachSocket(p,ws){ if(p.graceTimer){ clearTimeout(p.graceTimer); p.graceTimer=null; } if(!p.ws||!p.ws.sockets) p.ws=makeMux(p.ws?[p.ws]:[]); p.ws.sockets.add(ws); }
function detachSocket(p,ws){ if(p&&p.ws&&p.ws.sockets) p.ws.sockets.delete(ws); }
function openSockets(p){ return (p&&p.ws&&p.ws.sockets)?[...p.ws.sockets].filter(x=>x&&x.readyState===1):[]; }
// the room player that belongs to this connection: same connection id, else same Telegram account
function playerOf(room,client){
  if(!room||!client) return null;
  let p=room.players.find(x=>x.playerId===client.playerId);
  if(!p&&client.telegramId) p=room.players.find(x=>String(x.telegramId||'')===String(client.telegramId));
  return p||null;
}
// everything a device needs to show the player's current cartelas
function selectionPayload(p){
  const num=id=>{const c=id?getCard(id):null;return c?c.numbers:[];};
  return {cardId:p.cardId||null,cardNumbers:num(p.cardId),cardId2:p.cardId2||null,cardNumbers2:num(p.cardId2),
          cardId3:p.cardId3||null,cardNumbers3:num(p.cardId3),cardId4:p.cardId4||null,cardNumbers4:num(p.cardId4)};
}

function clientRooms(client){
  if(!client.rooms) client.rooms=new Set();
  return Array.from(client.rooms).map(id=>rooms[id]).filter(Boolean);
}
// the room a message is about: msg.roomId if the client belongs to it, else the room it is viewing
function roomForMsg(client,msg){
  const id=(msg&&msg.roomId&&client.rooms&&client.rooms.has(msg.roomId))?msg.roomId:client.roomId;
  return id?rooms[id]:null;
}
// money already reserved by this client's card picks in OTHER rooms that have not started yet
function reservedElsewhere(client,room){
  return clientRooms(client).reduce((sum,r)=>{
    if(r.roomId===room.roomId||(r.status!=='waiting'&&r.status!=='countdown')) return sum;
    const pl=playerOf(r,client);
    return sum+(pl?Number(r.stake)*getPlayerCardCount(pl):0);
  },0);
}
// re-link every room entry of a Telegram account to this connection (after a reload / reconnect)
function relinkAllRooms(client,ws,tid){
  if(!tid) return;
  if(!client.rooms) client.rooms=new Set();
  Object.values(rooms).forEach(r=>{
    r.players.forEach(pl=>{
      if(String(pl.telegramId||'')!==String(tid)) return;
      attachSocket(pl,ws);                 // this device joins the same player (other devices keep working)
      pl.playerId=client.playerId;         // the newest device is the primary one
      client.rooms.add(r.roomId);
    });
  });
}
const broadcast=(room,msg)=>{const s=JSON.stringify({roomId:room.roomId,stakeId:room.stakeId,gameId:room.dbGameCode||undefined,...msg});room.players.forEach(p=>{if(p.ws&&p.ws.readyState===WebSocket.OPEN)p.ws.send(s);});};
function broadcastLobby(){
  // Debounced: many joins/leaves happening in quick succession (busy lobby with
  // hundreds of players) will collapse into a single broadcast every 250ms,
  // instead of one full broadcast-to-everyone per event.
  if(broadcastLobby._pending) return;
  broadcastLobby._pending=true;
  setTimeout(()=>{
    broadcastLobby._pending=false;
    const payload=STAKES.map(s=>{const r=Object.values(rooms).find(r=>r.stakeId===s.id);
      return{stakeId:s.id,amount:s.amount,maxPlayers:s.maxPlayers,playerCount:r?r.players.length:0,status:r?r.status:'waiting',countdown:r&&r.status==='countdown'?r.countdownLeft:0};});
    Object.values(clients).forEach(c=>{
      if(!c.ws||c.ws.readyState!==WebSocket.OPEN) return;
      // stakes where this player has a game running (shown as "In game" in the lobby)
      const joined=clientRooms(c).filter(r=>r.status==='playing'&&r.players.some(pl=>pl.playerId===c.playerId&&(getPlayerCardCount(pl)>0||pl.hasPaid))).map(r=>r.stakeId);
      c.ws.send(JSON.stringify({type:'lobbyUpdate',stakes:payload,joined}));
    });
  },250);
}
function getPlayerCardIds(p){
  return [p.cardId,p.cardId2,p.cardId3,p.cardId4].filter(Boolean);
}
function getPlayerCardCount(p){ return getPlayerCardIds(p).length; }
function getCardField(slot){ return slot===1?'cardId':slot===2?'cardId2':slot===3?'cardId3':'cardId4'; }
function getNumbersField(slot){ return slot===1?'cardNumbers':slot===2?'cardNumbers2':slot===3?'cardNumbers3':'cardNumbers4'; }

function broadcastCardPool(room){
  // Send only the FULL pool once when needed (e.g. on join); for live picks use broadcastCardDiff instead.
  const base=getCardPoolForRoom(room).map(c=>({id:c.id,taken:room.takenCardIds.has(c.id)}));
  const cardCount=room.players.reduce((sum,p)=>sum+getPlayerCardCount(p),0);
  room.players.forEach(p=>send(p.ws,{roomId:room.roomId,stakeId:room.stakeId,type:'cardPoolUpdate',pool:base.map(c=>({...c,takenByMe:getPlayerCardIds(p).includes(c.id)})),playerCount:cardCount,stakeAmount:room.stake}));
}
// Lightweight update: tell everyone in the room only WHICH card(s) changed state,
// instead of re-sending the entire 400-card array on every single pick.
// This is the #1 fix for handling 400 concurrent players smoothly.
function broadcastCardDiff(room, changedCardIds){
  const cardCount=room.players.reduce((sum,p)=>sum+getPlayerCardCount(p),0);
  const changes=changedCardIds.map(id=>({id,taken:room.takenCardIds.has(id)}));
  room.players.forEach(p=>send(p.ws,{
    roomId:room.roomId,stakeId:room.stakeId,
    type:'cardPoolDiff',
    changes:changes.map(c=>({...c,takenByMe:getPlayerCardIds(p).includes(c.id)})),
    playerCount:cardCount,
    stakeAmount:room.stake
  }));
}

// ─── GAME LIFECYCLE ──────────────────────────────────────────
function startCountdown(room){
  room.status='countdown'; room.countdownLeft=Math.ceil((room.selectionSeconds?room.selectionSeconds*1000:LOBBY_WAIT_MS)/1000);
  room.countdownTimer=setInterval(()=>{
    room.countdownLeft--;
    const ready=room.players.filter(p=>p.cardId).length;
    if(ready<(room.minPlayers||2)){clearInterval(room.countdownTimer);room.status='waiting';broadcast(room,{type:'waitingForPlayers'});broadcastLobby();return;}
    broadcast(room,{type:'countdown',seconds:room.countdownLeft});
    if(room.countdownLeft<=0){clearInterval(room.countdownTimer);startGame(room);}
  },1000);
}

// ── Round start with db.js ──────────────────────────────────────
// createBingoGame() validates the room + stake, charges EVERY cartela from the player's wallets
// (play / main / bonus, in the order the funding policy says), creates the game and returns the
// prize pool. It is one database transaction: either the whole game is created or nothing is charged.
function releasePlayerCards(room,p){
  getPlayerCardIds(p).forEach(id=>room.takenCardIds.delete(id));
  p.cardId=null; p.cardId2=null; p.cardId3=null; p.cardId4=null; p.hasPaid=false;
}
async function collectDbEntries(room){
  const entries=[];
  for(const p of room.players){
    if(getPlayerCardCount(p)===0) continue;
    if(openSockets(p).length===0){                  // disconnected right now: no charge, no cartelas in this round
      console.warn(`player ${p.telegramId} was not connected when the round started - cartelas released`);
      releasePlayerCards(room,p);
      continue;
    }
    if(!p.userId){
      const u=await loadUser(p.telegramId,2,200);
      p.userId=u?.userId||null;
    }
    if(!p.userId){                                  // not registered: cannot play
      sendRoom(room,p.ws,{type:'error',message:'መለያዎ አልተገኘም። እባክዎ በቦቱ ይመዝገቡ።'});
      releasePlayerCards(room,p);
      continue;
    }
    [1,2,3,4].forEach(slot=>{
      const id=p[getCardField(slot)];
      if(id) entries.push({p,slot,cardId:id,userId:p.userId});
    });
  }
  return entries;
}
// After a failed attempt: find players who cannot afford their cartelas, release their cards.
async function dropUnaffordablePlayers(room){
  let dropped=false;
  await forEachLimit(room.players.filter(p=>getPlayerCardCount(p)>0),10,async p=>{
    const u=await loadUser(p.telegramId,1,0);
    if(!u) return;
    const need=room.stake*getPlayerCardCount(p);
    if(Number(u.spendable)<need){
      releasePlayerCards(room,p);
      sendRoom(room,p.ws,{type:'error',message:`በቂ ቀሪ ሂሳብ የለዎትም። ${need} ብር ያስፈልጋል።`});
      dropped=true;
    }
  });
  if(dropped) broadcastCardPool(room);
  return dropped;
}
// Short, friendly reason + code for players. Admins also get the database's own message.
function startFailureInfo(reason){
  const r=String(reason||'');
  if(/at least \d+ players|players are required|minimum.*players|min.*players/i.test(r))
    return {code:'MIN_PLAYERS',text:'ጨዋታውን ለመጀመር ቢያንስ 2 የተለያዩ ተጫዋቾች ያስፈልጋሉ።'};
  if(/room.*(not found|not active)|stake.*(not active|not exist|not available)|game system|funding policy|commission rule|ids are missing|configuration/i.test(r))
    return {code:'SETUP',text:'የክፍሉ ማዋቀር አልተጠናቀቀም። እባክዎ አስተዳዳሪን ያነጋግሩ።'};
  if(/uq_bingo_games_active_room_stake|active game/i.test(r))
    return {code:'STUCK_GAME',text:'ለዚህ ክፍል ያልተጠናቀቀ የቀድሞ ጨዋታ አለ። እባክዎ ትንሽ ቆይተው ይሞክሩ።'};
  if(/bonus consumption mismatch/i.test(r))
    return {code:'BONUS',text:'የቦነስ ሂሳብ ችግር አለ። እባክዎ አስተዳዳሪን ያነጋግሩ።'};
  if(/insufficient|balance/i.test(r))
    return {code:'BALANCE',text:'አንዳንድ ተጫዋቾች በቂ ቀሪ ሂሳብ የላቸውም።'};
  if(/no cartelas/i.test(r))
    return {code:'NO_CARTELAS',text:'ካርቴላ አልተመረጠም።'};
  return {code:'UNKNOWN',text:'ጨዋታው መጀመር አልተቻለም። እባክዎ እንደገና ይሞክሩ።'};
}
// A player whose Bonus wallet is not covered by active bonus awards would make place_stake() raise
// "Bonus consumption mismatch" and block the round for EVERYONE. Take only those players out.
async function dropBonusMismatchPlayers(room){
  if(typeof bingoDb.getBingoBonusStatus!=='function') return false;
  const players=room.players.filter(p=>getPlayerCardCount(p)>0&&p.userId);
  if(!players.length) return false;
  let rows;
  try{ rows=await bingoDb.getBingoBonusStatus(players.map(p=>p.userId)); }
  catch(e){ console.error('getBingoBonusStatus:',e.message); return false; }
  const bad=new Set(rows.filter(r=>Number(r.bonus_balance)-Number(r.usable)>0.009).map(r=>Number(r.user_id)));
  if(!bad.size) return false;
  for(const p of players){
    if(!bad.has(Number(p.userId))) continue;
    const r=rows.find(x=>Number(x.user_id)===Number(p.userId));
    console.error(`⚠️ user ${p.userId}: Bonus wallet ${r.bonus_balance} is not covered by active bonuses (${r.usable}); removed from the round`);
    releasePlayerCards(room,p);
    sendRoom(room,p.ws,{type:'error',message:'የቦነስ ሂሳብዎ ላይ ችግር ስላለ በዚህ ዙር መሳተፍ አልተቻለም። እባክዎ ድጋፍን ያነጋግሩ። (BONUS)'});
  }
  broadcastCardPool(room);
  return true;
}
function failStart(room,reason){
  console.error(`⚠️ Round could not start (${room.stakeId}): ${reason}`);
  room.status='waiting';
  room.startFailures=(room.startFailures||0)+1;
  room.lastStartError=String(reason||'');
  const info=startFailureInfo(reason);
  room.players.forEach(p=>{
    const admin=Object.values(clients).some(c=>c.isAdmin&&String(c.telegramId)===String(p.telegramId));
    sendRoom(room,p.ws,{type:'error',message:`${info.text} (${info.code})`+(admin?`\n${String(reason).slice(0,160)}`:'')});
  });
  broadcast(room,{type:'waitingForPlayers'});
  broadcastCardPool(room);
  broadcastLobby();
  // Try again if enough players still hold cards (at most 3 automatic retries)
  const ready=room.players.filter(p=>p.cardId).length;
  if(ready>=(room.minPlayers||2)&&room.startFailures<3){
    setTimeout(()=>{ if(rooms[room.roomId]&&room.status==='waiting') startCountdown(room); },3000);
  }
  return false;
}
// ── Orphaned games ──────────────────────────────────────────────────────────
// A game is created as "selection" and only end_bingo_game() closes it. If this server restarted in the
// middle of a round, the round is lost from memory but the game stays open in the database, and the unique
// index uq_bingo_games_active_room_stake then refuses every new game for that room + stake.
// Open games that no room of THIS server owns are cancelled with a full refund (cancel_bingo_game).
function ownedGameIds(){
  const ids=new Set();
  Object.values(rooms).forEach(r=>{ if(r.dbGameId) ids.add(Number(r.dbGameId)); });
  return ids;
}
async function recoverOrphanedGames({roomId=null,stakeId=null,minAgeSec=0,reason='orphaned_game'}={}){
  if(!bingoDb||typeof bingoDb.getUnfinishedBingoGames!=='function'||typeof bingoDb.cancelBingoGame!=='function') return 0;
  let games;
  try{ games=await bingoDb.getUnfinishedBingoGames(roomId,stakeId); }
  catch(e){ console.error('getUnfinishedBingoGames:',e.message); return 0; }
  const owned=ownedGameIds();
  let cancelled=0;
  for(const g of games){
    if(owned.has(Number(g.id))) continue;                 // a round of this server is still running it
    if(g.winners>0){ console.warn(`⚠️ Game ${g.game_code} has winners but is still open: finish it with end_bingo_game(), it is not cancelled automatically.`); continue; }
    if(g.age_seconds<minAgeSec) continue;                 // too young: it may belong to another instance during a deploy
    try{
      const r=await bingoDb.cancelBingoGame(g.id,reason);
      console.warn(`🧹 Cancelled unfinished game ${g.game_code} (${g.status}, ${g.age_seconds}s old, ${reason}): refunded ${r&&r.refunded_cards} cartela(s), ${r&&r.refunded_total} ETB`);
      cancelled++;
    }catch(e){
      console.error(`cancel_bingo_game(${g.id}) failed:`,e.message,e.message&&/cancel_bingo_game/.test(e.message)?'- install cancel_bingo_game.sql in the database':'');
    }
  }
  return cancelled;
}

async function startDbGame(room){
  for(let attempt=1;attempt<=3;attempt++){
    const entries=await collectDbEntries(room);
    if(!entries.length) return failStart(room,'no cartelas selected');
    if(!room.dbRoomId||!room.dbStakeId) return failStart(room,'room/stake ids are missing (stakes not loaded from the database)');

    let result;
    try{
      result=await bingoDb.createBingoGame(
        room.dbRoomId,
        room.dbStakeId,
        entries.map(e=>({user_id:e.userId,card_id:e.cardId,card_data:{numbers:(getCard(e.cardId)||{}).numbers||[],slot:e.slot}}))
      );
    }catch(e){
      console.error(`createBingoGame failed (attempt ${attempt}):`,e.message);
      if(/is_banned/.test(e.message)) console.error('DATABASE FIX NEEDED: create_bingo_game_from_selections reads users.is_banned but the column does not exist. Run: ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_banned boolean NOT NULL DEFAULT false;');
      // an older game of this room + stake was never closed: cancel it (refunding its players) and try again
      if(/uq_bingo_games_active_room_stake/i.test(e.message) && attempt<3){
        const n=await recoverOrphanedGames({roomId:room.dbRoomId,stakeId:room.dbStakeId,minAgeSec:120,reason:'orphaned_game'});
        if(n>0) continue;
      }
      // retry without the players who cannot pay / whose bonus is inconsistent (up to 2 retries)
      if(attempt<3 && ((await dropBonusMismatchPlayers(room)) || (await dropUnaffordablePlayers(room)))) continue;
      return failStart(room,e.message);
    }

    // Keep exactly the cartelas the database accepted (and charged).
    const accepted=new Set((result.accepted||[]).map(a=>`${a.user_id}:${a.card_id}`));
    for(const e of entries){
      if(accepted.has(`${e.userId}:${e.cardId}`)) continue;
      room.takenCardIds.delete(e.cardId);
      e.p[getCardField(e.slot)]=null;
      const rej=(result.rejected||[]).find(r=>Number(r.user_id)===e.userId&&Number(r.card_id)===e.cardId);
      const why=rej&&rej.reason;
      const text=why==='insufficient_balance'?`ካርቴላ ${e.cardId} አልተቀበለም — በቂ ቀሪ ሂሳብ የለም።`
        :(why==='user_blocked'||why==='user_banned'||why==='user_inactive')?'መለያዎ ለጊዜው ተዘግቷል። እባክዎ ድጋፍን ያነጋግሩ።'
        :why==='max_cards_per_player_reached'?`በዚህ ክፍል የሚፈቀደው የካርቴላ ብዛት አልፏል።`
        :`ካርቴላ ${e.cardId} አልተቀበለም።`;
      console.warn(`cartela ${e.cardId} of user ${e.userId} refused by the database: ${why||'not accepted'}`);
      sendRoom(room,e.p.ws,{type:'error',message:text});
    }
    room.players.forEach(p=>{ p.hasPaid=getPlayerCardCount(p)>0; });

    room.pot=Number(result.prize_pool)||0;          // the prize pool the DATABASE calculated (after commission)
    room.grossPot=Number(result.gross_pot)||0;
    room.dbGameId=Number(result.game_id)||null;
    room.dbGameCode=result.game_code||null;
    room.startFailures=0;
    console.log(`🎮 Game ${room.dbGameCode||room.dbGameId} created (${room.stakeId}): ${result.total_participants} players, ${result.total_cards} cartelas, gross ${result.gross_pot}, prize ${result.prize_pool}`);

    // Everyone's wallets changed: reload them once and push them to the apps.
    forEachLimit(room.players.filter(p=>p.hasPaid),10,pushWallets).catch(()=>{});
    return true;
  }
  return false;
}

async function startGame(room){
  // Lock the room before the first await so no new card reservations can race
  // with the final financial commit. Card selection itself is always memory-only.
  room.status='starting';

  if(USE_BINGO_DB){
    const ok=await startDbGame(room);
    if(!ok) return;
  }else{
  for(const p of room.players){
    if(getPlayerCardCount(p)===0) continue; // spectator

    if(!p.hasPaid){
      const cl=clients[p.playerId];
      const numCards=getPlayerCardCount(p);
      const totalCost=room.stake*numCards;

      // This is normally already paid during card selection. This fallback
      // protects the game if an older client reached startGame unpaid.
      if(cl){
        await refreshClientBalance(cl);
        const newBal=await changeClientBalance(cl,-totalCost,'stake',room.roomId);
        if(newBal!==null){
          p.hasPaid=true;
          send(p.ws,{type:'balanceUpdate',balance:newBal});
        }else{
          getPlayerCardIds(p).forEach(id=>room.takenCardIds.delete(id));
          p.cardId=null; p.cardId2=null; p.cardId3=null; p.cardId4=null;
          continue;
        }
      }else{
        getPlayerCardIds(p).forEach(id=>room.takenCardIds.delete(id));
        p.cardId=null; p.cardId2=null; p.cardId3=null; p.cardId4=null;
        continue;
      }
    }
  }

  }

  room.status='playing';
  if(!USE_BINGO_DB){
    const paidCards=room.players.reduce((s,p)=>s+(p.hasPaid?(getPlayerCardCount(p)):0),0);
    const grossPot=paidCards*room.stake;
    room.pot=Math.floor(grossPot*(1-HOUSE_CUT));
  }
  room.calledNumbers=[]; room.availableNumbers=Array.from({length:75},(_,i)=>i+1);
  room.claimedThisRound=[]; room.claimWindowOpen=false;
  if(!USE_BINGO_DB&&db){try{room.dbGameId=await db.saveGame(room.roomId,room.stakeId,room.stake,room.players.reduce((s,p)=>s+(p.hasPaid?(getPlayerCardCount(p)):0),0)*room.stake);}catch(e){console.error('saveGame:',e.message);}}

  room.players.forEach(p=>{
    if(getPlayerCardCount(p)>0){
      const card=p.cardId?getCard(p.cardId):null;
      const card2=p.cardId2?getCard(p.cardId2):null;
      sendRoom(room,p.ws,{type:'yourCard',
        cardId:p.cardId,cardNumbers:card?card.numbers:[],
        cardId2:p.cardId2||null,cardNumbers2:card2?card2.numbers:[],
        cardId3:p.cardId3||null,cardNumbers3:p.cardId3?getCard(p.cardId3).numbers:[],
        cardId4:p.cardId4||null,cardNumbers4:p.cardId4?getCard(p.cardId4).numbers:[],
        pot:room.pot,playerCount:livePlayerCount(room),spectator:false});
    }else{
      sendRoom(room,p.ws,{type:'spectating',pot:room.pot,playerCount:room.players.filter(p=>p.hasPaid).length,calledNumbers:room.calledNumbers});
    }
  });

  broadcast(room,{type:'gameStart',pot:room.pot,playerCount:livePlayerCount(room),players:paidPlayerList(room)});
  broadcastLobby(); scheduleNextCall(room);
}

function scheduleNextCall(room){room.callTimer=setTimeout(()=>callNumber(room),CALL_INTERVAL_MS);}

function callNumber(room){
  if(room.status!=='playing') return;

  // FIX 1: Evaluate ALL pending claims BEFORE calling next number.
  // This lets multiple simultaneous winners be detected in the same window.
  if(room.claimedThisRound.length>0){evaluateClaims(room);return;}
  room.claimWindowOpen=false; room.claimedThisRound=[];
  if(room.availableNumbers.length===0){endGame(room,[],null,true);return;}
  const idx=randomIndex(room.availableNumbers.length);
  const drawn=room.availableNumbers.splice(idx,1)[0];
  room.calledNumbers.push(drawn);
  broadcast(room,{type:'numberCalled',number:drawn,calledNumbers:room.calledNumbers,callCount:room.calledNumbers.length,claimWindowMs:CLAIM_WINDOW_MS,pot:room.pot,playerCount:livePlayerCount(room),players:paidPlayerList(room)});
  room.claimWindowOpen=true; scheduleNextCall(room);
  autoClaimForAll(room);
}

// The game is fully automatic: every called number is marked on every cartela.
// The server therefore claims BINGO for any winning player itself. This is what lets a
// player run 2-3 games at the same time: a game he is not looking at (or whose screen is
// closed) is still claimed and paid correctly. Duplicate claims from the app are ignored.
function autoClaimForAll(room){
  if(room.status!=='playing') return;
  room.players.forEach(p=>{
    if(p.disqualified||!p.hasPaid||getPlayerCardCount(p)===0) return;
    if(room.claimedThisRound.find(c=>c.playerId===p.playerId)) return;
    const claim={playerId:p.playerId,markedIndices:[],cardId2:null,markedIndices2:[],cardId3:null,markedIndices3:[],cardId4:null,markedIndices4:[]};
    let wins=false;
    [1,2,3,4].forEach(slot=>{
      const id=p[getCardField(slot)]; if(!id) return;
      const card=getCard(id); if(!card) return;
      const marks=[]; card.numbers.forEach((num,i)=>{ if(i===12||room.calledNumbers.includes(num)) marks.push(i); });
      claim['markedIndices'+(slot===1?'':slot)]=marks;
      if(slot>1) claim['cardId'+slot]=id;
      if(checkWin(card.numbers,room.calledNumbers,marks)) wins=true;
    });
    if(wins) room.claimedThisRound.push(claim);
  });
  if(room.claimedThisRound.length){
    if(room.callTimer) clearTimeout(room.callTimer);
    if(room.claimEvalTimer) clearTimeout(room.claimEvalTimer);
    room.claimEvalTimer=setTimeout(()=>evaluateClaims(room),CLAIM_COLLECT_MS);
  }
}

function evaluateClaims(room){
  room.claimEvalTimer=null;
  const winners=[], cheaters=[];
  room.claimedThisRound.forEach(claim=>{
    const p=room.players.find(p=>p.playerId===claim.playerId);
    if(!p||p.disqualified||getPlayerCardCount(p)===0) return;
    const wins=[1,2,3,4].map(slot=>{
      const id=p[getCardField(slot)];
      const card=id?getCard(id):null;
      const marks=claim['markedIndices'+(slot===1?'':slot)]||[];
      return {slot,id,win:!!(card&&checkWin(card.numbers,room.calledNumbers,marks)),marks};
    });
    const winning=wins.find(x=>x.win);
    if(winning){
      p._winningCardId=winning.id;
      p._winningMarkedIndices=Array.from(winning.marks);
      winners.push(p);
    }else cheaters.push(p);
  });

  cheaters.forEach(p=>{
    p.disqualified=true;
    sendRoom(room,p.ws,{type:'disqualified',message:'🚫 የተሳሳተ BINGO ጥያቄ — ከጨዋታው ተሰርዘዋል!'});
  });

  room.claimedThisRound=[]; room.claimWindowOpen=false;

  if(winners.length>0) endGame(room,winners,null,false);
  else scheduleNextCall(room);
}

// Pay the winners with db.js. Returns {winAmount, names, tids} or null if the database call failed.
// end_bingo_game(game, winning CARTELA numbers, numbers called in this round) pays every winner from the prize
// pool in one transaction and stores the called numbers with the game.
async function settleDbGame(room,winners){
  if(!room.dbGameId){ console.error('settleDbGame: this round has no database game id'); return null; }
  const ids=[...new Set(winners.map(w=>Number(w._winningCardId||w.cardId)).filter(n=>Number.isInteger(n)&&n>0))];
  const called=(room.calledNumbers||[]).map(Number).filter(n=>Number.isInteger(n)&&n>=1&&n<=75);   // snapshot at the moment of the win
  if(!ids.length||!called.length){
    console.error(`CRITICAL: cannot settle game ${room.dbGameCode||room.dbGameId}: winning cartelas ${JSON.stringify(ids)}, called numbers ${called.length}`);
    return null;
  }
  let result=null;
  for(let attempt=1;attempt<=3&&!result;attempt++){
    try{ result=await bingoDb.endBingoGame(room.dbGameId,ids,called); }
    catch(e){
      console.error(`endBingoGame failed (attempt ${attempt}/3) game ${room.dbGameCode||room.dbGameId}:`,e.message);
      if(/already completed|already been settled/i.test(e.message)){ result={winner_details:[],already:true}; break; }
      if(attempt<3) await new Promise(r=>setTimeout(r,attempt*1500));
    }
  }
  if(!result){
    console.error(`CRITICAL: winners of game ${room.dbGameCode||room.dbGameId} were NOT paid. Run: SELECT public.end_bingo_game(${room.dbGameId}, ARRAY[${ids.join(',')}]::integer[], ARRAY[${called.join(',')}]::integer[]);`);
    return null;
  }
  const rows=Array.isArray(result.winner_details)?result.winner_details:(Array.isArray(result.winners)?result.winners:[]);
  const names=winners.map(w=>w.playerName);
  const tids=winners.map(w=>String(w.telegramId||'')).filter(Boolean);
  const first=rows.length?Number(rows[0].payout):Math.floor((room.pot||0)/winners.length);
  console.log(`🏆 Game ${room.dbGameCode||room.dbGameId} settled: paid ${result.total_payout??result.total_paid??'?'} to ${rows.length||winners.length} winning cartela(s), ${called.length} numbers called`);
  // the winners' wallets changed: reload once and push
  forEachLimit(winners,10,async w=>{ await pushWallets(w); }).catch(()=>{});
  return {winAmount:first,names,tids};
}

async function endGame(room, winners, customMsg, noWinner){
  if(room.callTimer) clearTimeout(room.callTimer);
  if(room.countdownTimer) clearInterval(room.countdownTimer);
  if(room.claimEvalTimer) clearTimeout(room.claimEvalTimer);
  room.status='finished'; room.claimWindowOpen=false;

  let winAmount=0, winnerNames=[], winnerTids=[];

  if(USE_BINGO_DB){
    // ── db.js: endBingoGame() pays every winner from the prize pool in ONE transaction ──
    if(winners&&winners.length>0){
      const paid=await settleDbGame(room,winners);
      if(paid){ winAmount=paid.winAmount; winnerNames=paid.names; winnerTids=paid.tids; }
      else{ winnerNames=winners.map(w=>w.playerName); winnerTids=winners.map(w=>String(w.telegramId||'')).filter(Boolean); winAmount=Math.floor((room.pot||0)/winners.length); }
    }else if(room.dbGameId){
      // nobody won (all numbers called): close the game and give every stake back
      try{
        if(typeof bingoDb.cancelBingoGame!=='function') throw new Error('cancelBingoGame is not available in db.js');
        const r=await bingoDb.cancelBingoGame(room.dbGameId,'no_winner');
        console.warn(`↩️ Game ${room.dbGameCode||room.dbGameId} ended with no winner: refunded ${r&&r.refunded_cards} cartela(s), ${r&&r.refunded_total} ETB`);
        forEachLimit(room.players.filter(p=>p.hasPaid),10,pushWallets).catch(()=>{});
      }catch(e){
        console.error(`⚠️ Game ${room.dbGameCode||room.dbGameId} ended with no winner and could not be cancelled: ${e.message}. The game stays open and blocks this stake: install cancel_bingo_game.sql (adds cancel_bingo_game) and cancelBingoGame in db.js, or cancel it by hand.`);
      }
    }
    if(room.dbGameId){
      room.players.forEach(p=>{ if(p.telegramId) profileCache.delete(String(p.telegramId)); });
    }
  }else{
  if(winners&&winners.length>0){
    const prizePool=room.pot;
    winAmount=Math.floor(prizePool/winners.length);
    winnerNames=winners.map(w=>w.playerName);

    for(const w of winners){
      const cl=clients[w.playerId];
      const tid=String(w.telegramId||cl?.telegramId||'');
      if(tid) winnerTids.push(tid);

      // Pay from the authoritative Neon balance even if the winner refreshed,
      // reconnected, or temporarily disconnected during the game.
      if(tid && db){
        const target=cl||{telegramId:tid,balance:0,ws:w.ws,playerId:w.playerId};
        const newBal=await changeClientBalance(target,winAmount,'win',room.roomId);
        if(newBal!==null){
          if(cl) cl.balance=newBal;
          send(w.ws,{type:'balanceUpdate',balance:newBal});
        }else{
          console.error('Failed to credit winner',tid,room.roomId);
        }
      }else if(cl){
        const newBal=await changeClientBalance(cl,winAmount,'win',room.roomId);
        send(w.ws,{type:'balanceUpdate',balance:newBal===null?cl.balance:newBal});
      }
    }
  }

  if(db&&room.dbGameId){
    try{await db.endGame(room.dbGameId,winnerTids,winAmount,winners.length>1,room.calledNumbers);}
    catch(e){console.error('endGame DB error:',e.message);}
  }else if(db&&!room.dbGameId){
    try{
      const grossPot=room.players.reduce((s,p)=>s+(p.hasPaid?(getPlayerCardCount(p)):0),0)*room.stake;
      const gid=await db.saveGame(room.roomId,room.stakeId,room.stake,grossPot);
      await db.endGame(gid,winnerTids,winAmount,winners.length>1,room.calledNumbers);
    }catch(e){console.error('endGame fallback DB error:',e.message);}
  }
  } // end legacy balance code

  const isSplit=winners&&winners.length>1;
  const msg=customMsg||(noWinner?'በዚህ ዙር አሸናፊ የለም':
    isSplit?`🤝 የተከፋፈለ ሽልማት! ${winnerNames.join(' & ')} እያንዳንዳቸው ${winAmount} ETB አሸንፈዋል!`
           :`🏆 ${winnerNames[0]} ${winAmount} ETB አሸንፈዋል!`);

  // Include the winning cartela(s) so both winners and losers see a clear
  // result page with the winning card, just like the reference design.
  const winningCards=(winners||[]).map(w=>{
    const winningId=w._winningCardId||w.cardId||null;
    const card=winningId?getCard(winningId):null;
    return {
      playerName:w.playerName,
      telegramId:String(w.telegramId||clients[w.playerId]?.telegramId||''),
      cardId:winningId,
      cardNumbers:card?card.numbers:[],
      markedIndices:Array.isArray(w._winningMarkedIndices)?w._winningMarkedIndices:[]
    };
  });

  // Broadcast the result to EVERY connected player in the room. Keep the room/stake
  // identifiers in this message so clients can return to the same stake.
  const RESET_SECONDS=room.next_round_seconds;
  broadcast(room,{
    type:'gameOver',
    roomId:room.roomId,
    stakeId:room.stakeId,
    winners:winnerNames,
    winAmount,
    isSplit,
    message:msg,
    noWinner:!!noWinner,
    winnerTelegramIds:winnerTids,
    winningCards,
    calledNumbers:room.calledNumbers,
    resetCountdown:RESET_SECONDS
  });

  // Send a real 9 -> 8 -> ... -> 1 countdown. The room remains finished during
  // this period, then is reset to WAITING and the SAME room is reused.
  if(room.resetCountdownTimer) clearInterval(room.resetCountdownTimer);
  let resetSeconds=RESET_SECONDS;
  room.resetCountdownTimer=setInterval(()=>{
    resetSeconds--;
    if(resetSeconds>0){
      broadcast(room,{type:'resetCountdown',roomId:room.roomId,stakeId:room.stakeId,seconds:resetSeconds});
    }
  },1000);

  room.resetTimer=setTimeout(()=>{
    if(room.resetCountdownTimer) clearInterval(room.resetCountdownTimer);
    room.resetCountdownTimer=null;
    if(!rooms[room.roomId]) return;

    room.status='waiting';
    room.calledNumbers=[];
    room.availableNumbers=Array.from({length:75},(_,i)=>i+1);
    room.pot=0;
    room.takenCardIds=new Set();
    room.claimedThisRound=[];
    room.claimWindowOpen=false;
    room.dbGameId=null;
    room.dbGameCode=null;
    room.participantCards=null;
    room.grossPot=0;
    room.startFailures=0;
    room.callTimer=null;
    room.claimEvalTimer=null;

    // IMPORTANT: players stay in this room, but their old cards/payment flags are
    // cleared so they can choose fresh cards for the next round.
    room.players.forEach(p=>{
      p.cardId=null;
      p.cardId2=null;
      p.cardId3=null;
      p.cardId4=null;
      p.hasPaid=false;
      p.disqualified=false;
    });

    // Players who had LEFT this game's screen (detached, usually playing another game now)
    // are removed from the finished room instead of being pulled back into it.
    room.players=room.players.filter(p=>{
      if(!p.detached) return true;
      const cl=clients[p.playerId];
      if(cl&&cl.rooms) cl.rooms.delete(room.roomId);
      if(cl&&cl.roomId===room.roomId) cl.roomId=null;
      sendRoom(room,p.ws,{type:'roomClosed'});
      return false;
    });
    if(room.players.length===0){ delete rooms[room.roomId]; broadcastLobby(); return; }

    room.players.forEach(p=>{
      const cl=clients[p.playerId];
      send(p.ws,{
        type:'backToCardSelection',
        roomId:room.roomId,
        stakeId:room.stakeId,
        balance:cl?cl.balance:0,
        wallets:cl?cl.wallets:undefined,
        playerCount:0,
        stakeAmount:room.stake,
        status:'waiting',
        // Include the fresh pool in the reset response so the client can switch
        // to card selection and render the new pool without a page reload.
        pool:getCardPoolForRoom(room).map(c=>({id:c.id,taken:false,takenByMe:false}))
      });
    });

    broadcastCardPool(room);
    broadcastLobby();
    // Do NOT start countdown here. Players must select fresh cards first.
  },RESET_SECONDS*1000);
}

async function leaveRoom(client,roomId){
  const rid=roomId||client.roomId;
  if(!rid) return;
  if(client.rooms) client.rooms.delete(rid);
  const room=rooms[rid];
  if(!room){ if(client.roomId===rid) client.roomId=null; return; }
  const p=playerOf(room,client);
  if(p){
    // another device of the same account is still in this room: only THIS device leaves,
    // the player and his cartelas stay for the other device(s)
    detachSocket(p,client.ws);
    if(openSockets(p).length){ if(client.roomId===rid) client.roomId=null; return; }
    if(p.cardId) room.takenCardIds.delete(p.cardId);
    getPlayerCardIds(p).forEach(id=>room.takenCardIds.delete(id));

    // Refund every paid card when leaving before the game starts.
    if(!USE_BINGO_DB&&p.hasPaid&&(room.status==='waiting'||room.status==='countdown')){
      const cardCount=getPlayerCardCount(p);
      const refund=room.stake*cardCount;
      if(refund>0){
        const newBal=await changeClientBalance(client,refund,'stake_refund',room.roomId);
        if(newBal!==null) send(client.ws,{type:'balanceUpdate',balance:newBal});
        else console.error('Failed to refund player',client.telegramId,room.roomId);
      }
      p.hasPaid=false;
    }
  }
  room.players=room.players.filter(x=>x!==p);
  if(client.roomId===rid) client.roomId=null;
  if(room.players.length===0){
    if(room.callTimer)clearTimeout(room.callTimer);
    if(room.countdownTimer)clearInterval(room.countdownTimer);
    delete rooms[room.roomId];
  }else{
    broadcastCardPool(room);broadcast(room,{type:'playerLeft',playerCount:room.players.length,players:room.players.map(p=>({playerId:p.playerId,playerName:p.playerName}))});
  }
  broadcastLobby();
}

// ─── WEBSOCKET ────────────────────────────────────────────────
wss.on('connection',(ws)=>{
  const playerId=uuidv4();
  const client={playerId,playerName:'',telegramId:null,balance:0,roomId:null,rooms:new Set(),isAdmin:false,ws};
  clients[playerId]=client; ws._pid=playerId;

  const lobbyStakes=STAKES.map(s=>{const r=Object.values(rooms).find(r=>r.stakeId===s.id);
    return{stakeId:s.id,amount:s.amount,maxPlayers:s.maxPlayers,playerCount:r?r.players.length:0,status:r?r.status:'waiting',countdown:r&&r.status==='countdown'?r.countdownLeft:0};});
  send(ws,{type:'connected',playerId,balance:0,stakes:lobbyStakes});

  ws.on('message',async raw=>{

    const queueClient=clients[ws._pid];

    queueClient.messageQueue=(queueClient.messageQueue||Promise.resolve()).then(async()=>{


        try{

          const client=clients[ws._pid];

          if(!client) return;


          // ── Rate limiting: max 15 messages/sec per connection ──

          // Protects against spam/DoS and prevents one misbehaving client

          // (buggy or malicious) from hogging CPU when 400 people are connected.

          const now=Date.now();

          if(!client._rl||now-client._rl.windowStart>1000){

            client._rl={windowStart:now,count:0};

          }

          client._rl.count++;

          if(client._rl.count>15){

            return; // silently drop excess messages this second

          }


          const msg=JSON.parse(raw);


          switch(msg.type){

            case 'telegramAuth':{
              const tid=String(msg.telegramId||'').trim();
              if(!/^\d+$/.test(tid) || Number(tid)<=0){
                send(ws,{type:'authRetry',retryAfter:1000});
                break;
              }
              const user=await loadUser(tid,6,500);
              if(user){
                client.telegramId=tid;
                applyUserToClient(client,user);
                client.playerName=user.name||client.playerName||'Player';
                relinkAllRooms(client,ws,tid);   // keep receiving every game this account is playing
                send(ws,{type:'authSuccess',playerName:client.playerName,balance:client.balance,wallets:client.wallets,isRegistered:true,isAdmin:client.isAdmin,adminToken:client.isAdmin?ADMIN_PHONE:undefined});
              } else {
                // Never convert a failed/late database lookup into a fake zero wallet.
                send(ws,{type:'authRetry',retryAfter:1000});
              }
              break;
            }

            case 'setName':{

              if(msg.name&&msg.name.trim()){client.playerName=msg.name.trim().substring(0,20);send(ws,{type:'nameSet',playerName:client.playerName});}

              break;

            }

          case 'reconnect':{

      const room=rooms[msg.roomId];

      if(!room){
        send(ws,{type:'reconnectFailed'}); break;
      }

      // After a round finishes the same room is deliberately kept in WAITING state.
      // Allow a page reload/reconnect to return to that room instead of forcing the
      // player back to the lobby.
      if(room.status!=='playing' && room.status!=='waiting' && room.status!=='countdown'){
        send(ws,{type:'reconnectFailed'}); break;
      }

      // Try by playerId first, fall back to telegramId for page-reload reconnects

      let ep=playerOf(room,client);
      if(!ep&&msg.telegramId){
        const tid=String(msg.telegramId);
        ep=room.players.find(p=>String(p.telegramId)===tid);
        if(ep) client.telegramId=tid;       // another device (or a reload) of the same account SHARES this player
      }
      if(ep){
        await refreshClientBalance(client);
        attachSocket(ep,ws); ep.playerId=client.playerId; client.roomId=msg.roomId; ep.detached=false;
        if(ep.detachedSockets) ep.detachedSockets.delete(ws);
        if(!client.rooms) client.rooms=new Set(); client.rooms.add(msg.roomId);
        relinkAllRooms(client,ws,String(msg.telegramId||client.telegramId||''));

        const card=ep.cardId?getCard(ep.cardId):null;

        const card2=ep.cardId2?getCard(ep.cardId2):null;

        if(room.status==='playing'){
          send(ws,{type:'reconnected',roomId:msg.roomId,stakeId:room.stakeId,

            cardId:ep.cardId,cardNumbers:card?card.numbers:[],

            cardId2:ep.cardId2||null,cardNumbers2:card2?card2.numbers:[],
            cardId3:ep.cardId3||null,cardNumbers3:ep.cardId3?getCard(ep.cardId3).numbers:[],
            cardId4:ep.cardId4||null,cardNumbers4:ep.cardId4?getCard(ep.cardId4).numbers:[],

            calledNumbers:room.calledNumbers,pot:room.pot,playerCount:livePlayerCount(room),balance:client.balance});
        }else{
          // WAITING/COUNTDOWN room: show fresh card selection state.
          send(ws,{type:'joinedRoom',roomId:room.roomId,stakeId:room.stakeId,
            balance:client.balance,status:room.status,
            countdownLeft:room.status==='countdown'?room.countdownLeft:0,
            countdown:room.status==='countdown'?room.countdownLeft:0,
            playerCount:room.players.reduce((sum,p)=>getPlayerCardCount(p)+sum,0),
            stakeAmount:room.stake,
            ...selectionPayload(ep)});
          broadcastCardPool(room);
          broadcastLobby();
        }

      } else {

        send(ws,{type:'reconnectFailed'});

      }

      break;

    }

           case 'joinRoom':{

                  let sc=STAKES.find(s=>s.id===msg.stakeId);
                 if(!sc){
                   // an older / differently written name ("s5", "S5", "stake5") still finds the stake with that amount
                   const m=String(msg.stakeId||'').match(/([0-9]+(?:\.[0-9]+)?)/);
                   if(m) sc=STAKES.find(s=>Number(s.amount)===Number(m[1]));
                   if(sc) msg.stakeId=sc.id;
                 }
                 if(!sc) return send(ws,{type:'error',message:'የተሳሳተ የውርርድ መጠን።'});


                 // Joining/navigating to page 2 must never be blocked by a database

                 // availability check. The wallet is validated only when a paid card

                 // is selected. Accept the Telegram ID here so the server can use it

                 // for that later validation even if telegramAuth arrived slightly late.

                 if(!client.telegramId && msg.telegramId){

                   const tid=String(msg.telegramId).trim();

                   if(tid){

                     client.telegramId=tid;

                     try{

                       const u=await loadUser(tid);

                       if(u){

                         applyUserToClient(client,u);

                       }

                     }catch(e){ console.error('joinRoom account lookup:',e.message); }

                   }

                 }


                 // A player may play several games at once (one room per stake). Rooms where he
                 // has a RUNNING game stay open. Any other room (card selection not started yet,
                 // or just watching) is left, which releases the picked cards as before.
                 for(const r of clientRooms(client)){
                   const pl=playerOf(r,client);
                   const runningGame=pl&&(r.status==='playing'||r.status==='starting')&&(getPlayerCardCount(pl)>0||pl.hasPaid);
                   // the room of the stake being joined is kept: a second device of the same account shares it
                   if(!runningGame && r.stakeId!==msg.stakeId) await leaveRoom(client,r.roomId);
                 }

              // ── Re-link an existing player before spectator handling. ──
              // A page/app reload creates a new WebSocket/playerId. If this Telegram
              // account already owns cards in the same stake room, it is the SAME
              // player and must never be added as a spectator/new player.
              const reconnectTid=String(client.telegramId||msg.telegramId||'').trim();
              if(reconnectTid){
                const existingRoom=Object.values(rooms).find(r=>
                  r.stakeId===msg.stakeId &&
                  (r.status==='waiting'||r.status==='countdown'||r.status==='playing') &&
                  r.players.some(p=>String(p.telegramId||'')===reconnectTid)
                );
                if(existingRoom){
                  const ep=existingRoom.players.find(p=>String(p.telegramId||'')===reconnectTid);
                  // second device of the same account: it joins the SAME player and sees the same cartelas
                  attachSocket(ep,ws);
                  ep.playerId=client.playerId;
                  ep.telegramId=reconnectTid;
                  if(ep.detachedSockets) ep.detachedSockets.delete(ws);
                  client.telegramId=reconnectTid;
                  client.roomId=existingRoom.roomId; ep.detached=false;
                  if(!client.rooms) client.rooms=new Set(); client.rooms.add(existingRoom.roomId);
                  relinkAllRooms(client,ws,reconnectTid);
                  await refreshClientBalance(client);
                  const card=ep.cardId?getCard(ep.cardId):null;
                  const card2=ep.cardId2?getCard(ep.cardId2):null;
                  if(existingRoom.status==='playing'){
                    send(ws,{type:'reconnected',roomId:existingRoom.roomId,stakeId:existingRoom.stakeId,
                      cardId:ep.cardId,cardNumbers:card?card.numbers:[],
                      cardId2:ep.cardId2||null,cardNumbers2:card2?card2.numbers:[],
            cardId3:ep.cardId3||null,cardNumbers3:ep.cardId3?getCard(ep.cardId3).numbers:[],
            cardId4:ep.cardId4||null,cardNumbers4:ep.cardId4?getCard(ep.cardId4).numbers:[],
                      calledNumbers:existingRoom.calledNumbers,pot:existingRoom.pot,
                      playerCount:livePlayerCount(existingRoom),balance:client.balance});
                  }else{
                    send(ws,{type:'joinedRoom',roomId:existingRoom.roomId,stakeId:existingRoom.stakeId,
                      balance:client.balance,status:existingRoom.status,
                      countdownLeft:existingRoom.status==='countdown'?existingRoom.countdownLeft:0,
                      countdown:existingRoom.status==='countdown'?existingRoom.countdownLeft:0,
                      playerCount:existingRoom.players.filter(p=>p.hasPaid).length,
                      stakeAmount:existingRoom.stake,
                      ...selectionPayload(ep)});
                    broadcastCardPool(existingRoom);
                  }
                  broadcastLobby();
                  break;
                }
              }

              // ── If a game for this stake is already in progress, join as a spectator ──

              const liveRoom=Object.values(rooms).find(r=>r.stakeId===msg.stakeId&&r.status==='playing');

              if(liveRoom){
                if(liveRoom.players.length>=liveRoom.maxPlayers) return send(ws,{type:'error',message:`ይህ ክፍል ሙሉ ነው። ከፍተኛው ተጫዋቾች: ${liveRoom.maxPlayers}`});
                liveRoom.players.push({playerId:client.playerId,playerName:client.playerName,telegramId:client.telegramId,userId:client.userId||userCache[String(client.telegramId)]?.userId||null,ws:makeMux([ws]),cardId:null,cardId2:null,cardId3:null,cardId4:null,hasPaid:false,disqualified:false});

                client.roomId=liveRoom.roomId; client.rooms.add(liveRoom.roomId);

                send(ws,{type:'joinedRoom',roomId:liveRoom.roomId,stakeId:liveRoom.stakeId,balance:client.balance,status:liveRoom.status});

                sendRoom(liveRoom,ws,{type:'spectating',pot:liveRoom.pot,playerCount:liveRoom.players.filter(p=>p.hasPaid).length,calledNumbers:liveRoom.calledNumbers});

                broadcastLobby();

                break;

              }

          

              const room=getOrCreateRoom(msg.stakeId);

              if(room.status!=='waiting'&&room.status!=='countdown') return send(ws,{type:'error',message:'ጨዋታው ቀድሞውኑ ተጀምሯል።'});

              room.players.push({playerId:client.playerId,playerName:client.playerName,telegramId:client.telegramId,userId:client.userId||userCache[String(client.telegramId)]?.userId||null,ws:makeMux([ws]),cardId:null,cardId2:null,cardId3:null,cardId4:null,hasPaid:false,disqualified:false});

              client.roomId=room.roomId; client.rooms.add(room.roomId);

              send(ws,{type:'joinedRoom',roomId:room.roomId,stakeId:room.stakeId,balance:client.balance,status:room.status,playerCount:room.players.reduce((sum,p)=>sum+getPlayerCardCount(p),0),stakeAmount:room.stake});

              broadcastCardPool(room); broadcastLobby();

                 const readyPlayers=room.players.filter(p=>p.cardId).length;

              if(readyPlayers>=(room.minPlayers||2)&&room.status==='waiting') startCountdown(room);

              break;

            }

            case 'selectCard':{
              const room=roomForMsg(client,msg);
              if(!room) break;
              // Selecting a card is intentionally memory-only. Never wait for the DB here.
              if(!room||(room.status!=='waiting'&&room.status!=='countdown')) break;
              const cardId=parseInt(msg.cardId);
              const slot=Math.max(1,Math.min(4,parseInt(msg.slot)||1));
              if(cardId<1||cardId>room.cardLimit) break;
              if(slot>(room.maxCards||4)) return send(ws,{type:'error',message:`በዚህ ክፍል እስከ ${room.maxCards||4} ካርቴላ ብቻ መምረጥ ይቻላል።`});
              const p=playerOf(room,client);
              if(!p) break;
              if(room.takenCardIds.has(cardId)) return send(ws,{type:'error',message:'ይህ ካርቴላ ቀድሞውኑ ተመርጧል!'});

              const field=getCardField(slot);
              const previous=p[field];
              const changedIds=new Set([cardId]);
              if(previous){
                room.takenCardIds.delete(previous);
                changedIds.add(previous);
              }

              // The player's selected cards are reservations only. No balance change
              // and no database call happens here, so rapid clicks are safe.
              if(!previous){
                const reservedAfter=getPlayerCardCount(p)+1;
                const required=Number(room.stake)*reservedAfter+reservedElsewhere(client,room);
                // Fast local guard only. The authoritative DB balance is checked again
                // once, when the game actually starts.
                let have=Number(client.spendable??client.balance);
                if(have<required){
                  // The wallet may have been topped up since sign-in: reload it once before refusing.
                  await refreshClientBalance(client);
                  have=Number(client.spendable??client.balance);
                  // the room may have changed while we waited
                  if(room.status!=='waiting'&&room.status!=='countdown') break;
                  if(room.takenCardIds.has(cardId)) return send(ws,{type:'error',message:'ይህ ካርቴላ ቀድሞውኑ ተመርጧል!'});
                }
                if(have<required){
                  if(previous) room.takenCardIds.add(previous);
                  return send(ws,{type:'error',message:`በቂ ቀሪ ሂሳብ የለዎትም። ለ${reservedAfter} ካርድ(ዎች) ${required} ብር ያስፈልጋል።`});
                }
              }

              p[field]=cardId;
              room.takenCardIds.add(cardId);
              const card=getCard(cardId);
              sendRoom(room,p.ws,{type:'cardSelected',cardId,cardNumbers:card.numbers,slot});
              broadcastCardDiff(room,Array.from(changedIds));
              const readyCount=room.players.filter(p=>p.cardId).length;
              if(readyCount>=(room.minPlayers||2)&&room.status==='waiting') startCountdown(room);
              break;
            }
            case 'deselectCard':{
              const room=roomForMsg(client,msg);
              if(!room) break;
              if(!room||(room.status!=='waiting'&&room.status!=='countdown')) break;
              const p=playerOf(room,client);
              if(!p) break;
              let slot=Math.max(1,Math.min(4,parseInt(msg.slot)||1));
              const wanted=parseInt(msg.cardId);
              if(wanted&&p[getCardField(slot)]!==wanted){                  // the slot sent does not hold this cartela: find the one that does
                const found=[1,2,3,4].find(sl=>p[getCardField(sl)]===wanted);
                if(found) slot=found;
              }
              const field=getCardField(slot);
              const releasedId=p[field];
              if(!releasedId) break;
              // Before the game starts this is only a reservation release.
              // Nothing was charged yet, so there is nothing to refund.
              room.takenCardIds.delete(releasedId);
              p[field]=null;
              if(getPlayerCardCount(p)===0) p.hasPaid=false;
              sendRoom(room,p.ws,{type:'cardDeselected',cardId:releasedId,slot});   // all devices drop it
              broadcastCardDiff(room,[releasedId]);
              break;
            }
            case 'claimBingo':{

              const room=roomForMsg(client,msg);
              if(!room) return;

              if(!room||room.status!=='playing') return;

              const p=playerOf(room,client);

              if(!p||p.disqualified||getPlayerCardCount(p)===0) return;

              if(!room.claimWindowOpen) return sendRoom(room,ws,{type:'claimTooLate',message:'ጊዜው አልፏል!'});

              if(!room.claimedThisRound.find(c=>c.playerId===p.playerId))

                room.claimedThisRound.push({

                  playerId:p.playerId,

                  markedIndices:msg.markedIndices||[],

                  cardId2:msg.cardId2||null,

                  markedIndices2:msg.markedIndices2||[],

                  cardId3:msg.cardId3||null,

                  markedIndices3:msg.markedIndices3||[],

                  cardId4:msg.cardId4||null,

                  markedIndices4:msg.markedIndices4||[]

                });

              if(room.callTimer) clearTimeout(room.callTimer);

              if(room.claimEvalTimer) clearTimeout(room.claimEvalTimer);

              room.claimEvalTimer=setTimeout(()=>evaluateClaims(room), CLAIM_COLLECT_MS);

              break;

            }

            case 'leaveRoom':

              await leaveRoom(client,msg.roomId); send(ws,{type:'leftRoom',roomId:msg.roomId||null,balance:client.balance}); break;

            // The player left the screen of a running game but is still playing it
            // (usually because he opened another game). Used to clean up after that game ends.
            case 'detachRoom':{
              const room=roomForMsg(client,msg);
              if(!room) break;
              const pl=playerOf(room,client);
              if(pl){
                pl.detachedSockets=(pl.detachedSockets||new Set()).add(ws);
                pl.detached=openSockets(pl).every(x=>pl.detachedSockets.has(x));
              }
              if(client.roomId===room.roomId) client.roomId=null;
              broadcastLobby();
              break;
            }


            // ── Deposit request ──

            case 'depositRequest':{

              const{amount,txRef}=msg;

              if(!amount||amount<10) return send(ws,{type:'error',message:'Minimum deposit is 10 ETB.'});

              if(!txRef||!txRef.trim()) return send(ws,{type:'error',message:'Transaction reference required.'});

              if(!client.telegramId) return send(ws,{type:'error',message:'Please register first via the Telegram bot (/start).'});

              if(db){

                try{

                  const id=await db.createDeposit(client.telegramId,amount,txRef.trim());

                  if(!id) return send(ws,{type:'error',message:'Account not found in database. Please send /start to the bot again.'});

                  send(ws,{type:'depositSubmitted',message:'Deposit request submitted! Waiting for admin approval.'});

                }catch(e){console.error('Deposit error:',e.message); send(ws,{type:'error',message:'Deposit failed: '+e.message});}

              } else {

                // Memory mode: auto-approve

                client.balance+=amount;

                send(ws,{type:'balanceUpdate',balance:client.balance});

                send(ws,{type:'depositSubmitted',message:'Deposit approved (demo mode).'});

              }

              break;

            }


            // ── Withdrawal request ──

            case 'withdrawalRequest':{

              const{amount}=msg;

              if(!amount||amount<50) return send(ws,{type:'error',message:'Minimum withdrawal is 50 ETB.'});

              if(!client.telegramId) return send(ws,{type:'error',message:'Please register first.'});

              await refreshClientBalance(client);

              if(db){

                try{

                  const result=await db.createWithdrawal(client.telegramId,amount);

                  if(result.error) return send(ws,{type:'error',message:result.error});

                  client.balance=result.newBalance;

                  send(ws,{type:'balanceUpdate',balance:client.balance});

                  send(ws,{type:'withdrawalSubmitted',message:'Withdrawal request submitted! Admin will process it soon.'});

                }catch(e){send(ws,{type:'error',message:'Failed to submit withdrawal.'});}

              } else {

                client.balance-=amount;

                send(ws,{type:'balanceUpdate',balance:client.balance});

                send(ws,{type:'withdrawalSubmitted',message:'Withdrawal submitted (demo mode).'});

              }

              break;

            }

          }

        }catch(err){console.error('WS:',err);}
  
    }).catch(e=>{

      console.error('WS message queue error:',e);

      send(ws,{type:'error',message:e.message||'Server error.'});

    });
});

  ws.on('close',()=>{
    const c=clients[ws._pid];
    if(!c) return;
    let keepClient=false;
    clientRooms(c).forEach(room=>{
      const p=playerOf(room,c);
      if(p) detachSocket(p,ws);
      if(p&&openSockets(p).length) return;                              // another device of this account is still connected
      if(room.status==='playing'&&p){ keepClient=true; }                // running games stay alive
      else if(p&&(room.status==='waiting'||room.status==='countdown')){
        // keep the seat and the cartelas for a short while: a quick reconnect (Refresh) gets everything back
        keepClient=true;
        if(p.graceTimer) clearTimeout(p.graceTimer);
        p.graceTimer=setTimeout(()=>{
          p.graceTimer=null;
          if(openSockets(p).length) return;                              // he came back (maybe on another connection)
          leaveRoom(c,room.roomId).catch(()=>{});
          if(!clientRooms(c).length) delete clients[c.playerId];
          broadcastLobby();
        },DISCONNECT_GRACE_MS);
      }
      else leaveRoom(c,room.roomId);
    });
    if(keepClient) return;
    delete clients[ws._pid]; broadcastLobby();
  });
  ws.on('error',()=>{});
});

// ─── ADMIN REST API ───────────────────────────────────────────
// Admin auth — accepts phone number OR telegram ID of the admin
function adminAuth(req,res,next){
  const tok=String(req.headers['x-admin-token']||req.query.token||'');
  if(isAdminPhone(tok)) return next();
  // Frontend sends telegramId as token — check if that user isAdmin
  const cl=Object.values(clients).find(c=>c.telegramId===tok);
  if(cl&&cl.isAdmin) return next();
  res.status(403).json({error:'Forbidden'});
}
app.get('/api/admin/admins',adminAuth,async(req,res)=>{
  if(!db)return res.json([]);
  res.json(await db.q('SELECT telegram_id,name,phone FROM users WHERE is_admin=true ORDER BY name'));
});
app.post('/api/admin/admins',adminAuth,async(req,res)=>{
  if(!db)return res.json({ok:true});
  const phone=String(req.body.phone||'').trim().replace(/^\+/,'');
  if(!phone)return res.status(400).json({error:'phone required'});
  const r=await db.q('UPDATE users SET is_admin=true WHERE phone=$1 RETURNING telegram_id,name,phone',[phone]);
  if(!r.length)return res.status(404).json({error:'User not found'});
  const cl=Object.values(clients).find(c=>c.telegramId===String(r[0].telegram_id));
  if(cl)cl.isAdmin=true;
  res.json({ok:true,user:r[0]});
});
app.delete('/api/admin/admins/:phone',adminAuth,async(req,res)=>{
  if(!db)return res.json({ok:true});
  const phone=decodeURIComponent(req.params.phone).replace(/^\+/,'');
  if(phone===ADMIN_PHONE)return res.status(403).json({error:'Cannot remove root admin'});
  await db.q('UPDATE users SET is_admin=false WHERE phone=$1',[phone]);
  const cl=Object.values(clients).find(c=>{const u=userCache[c.telegramId];return u&&u.phone===phone;});
  if(cl)cl.isAdmin=false;
  res.json({ok:true});
});

app.get('/api/admin/deposits', adminAuth, async(req,res)=>{
  if(!db) return res.json([]);
  res.json(await db.getDeposits(req.query.status||'pending'));
});
app.post('/api/admin/deposits/:id/approve', adminAuth, async(req,res)=>{
  if(!db) return res.json({ok:true});
  const result=await db.approveDeposit(parseInt(req.params.id));
  if(result){
    // Push balance update to connected user
    const cl=Object.values(clients).find(c=>c.telegramId===String(result.telegramId));
    if(cl){cl.balance=result.newBalance;send(cl.ws,{type:'balanceUpdate',balance:result.newBalance});send(cl.ws,{type:'notification',message:`✅ Deposit of ${result.amount} ETB approved!`});}
  }
  res.json({ok:true,result});
});
app.post('/api/admin/deposits/:id/reject', adminAuth, async(req,res)=>{
  if(!db) return res.json({ok:true});
  await db.rejectDeposit(parseInt(req.params.id));
  res.json({ok:true});
});

app.get('/api/admin/withdrawals', adminAuth, async(req,res)=>{
  if(!db) return res.json([]);
  res.json(await db.getWithdrawals(req.query.status||'pending'));
});
app.post('/api/admin/withdrawals/:id/approve', adminAuth, async(req,res)=>{
  if(!db) return res.json({ok:true});
  const result=await db.approveWithdrawal(parseInt(req.params.id));
  if(result){
    const cl=Object.values(clients).find(c=>c.telegramId===String(result.telegramId));
    if(cl) send(cl.ws,{type:'notification',message:`✅ Withdrawal of ${result.amount} ETB approved!`});
  }
  res.json({ok:true,result});
});
app.post('/api/admin/withdrawals/:id/reject', adminAuth, async(req,res)=>{
  if(!db) return res.json({ok:true});
  const result=await db.rejectWithdrawal(parseInt(req.params.id));
  if(result){
    const cl=Object.values(clients).find(c=>c.telegramId===String(result.telegramId));
    if(cl){cl.balance=result.newBalance;send(cl.ws,{type:'balanceUpdate',balance:result.newBalance});send(cl.ws,{type:'notification',message:`❌ Withdrawal rejected. ${result.newBalance} ETB refunded.`});}
  }
  res.json({ok:true,result});
});

app.get('/api/admin/search', adminAuth, async(req,res)=>{
  if(!db) return res.json([]);
  res.json(await db.searchByPhone(req.query.phone||''));
});

app.get('/api/admin/analytics', adminAuth, async(req,res)=>{
  if(!db) return res.json({error:'No database'});
  const { from, to } = req.query;
  const dateFrom = from ? new Date(from).toISOString() : new Date(Date.now()-30*86400000).toISOString();
  const dateTo   = to   ? new Date(new Date(to).setHours(23,59,59,999)).toISOString() : new Date().toISOString();
  try {
    const games = await db.q(
      `SELECT COUNT(*)::int as total_games,
              COALESCE(SUM(pot),0)::numeric as total_pot,
              COALESCE(SUM(win_amount),0)::numeric as total_paid_out,
              COUNT(CASE WHEN status='finished' THEN 1 END)::int as finished_games
       FROM games WHERE started_at BETWEEN $1 AND $2`, [dateFrom, dateTo]);

    const profit = await db.q(
      `SELECT COALESCE(SUM(pot - COALESCE(win_amount,0)),0)::numeric as house_profit
       FROM games WHERE status='finished' AND started_at BETWEEN $1 AND $2`, [dateFrom, dateTo]);

    const deposits = await db.q(
      `SELECT COUNT(*)::int as total,
              COUNT(CASE WHEN status='pending' THEN 1 END)::int as pending,
              COUNT(CASE WHEN status='approved' THEN 1 END)::int as approved,
              COUNT(CASE WHEN status='rejected' THEN 1 END)::int as rejected,
              COALESCE(SUM(CASE WHEN status='approved' THEN amount ELSE 0 END),0)::numeric as approved_amount,
              COALESCE(SUM(CASE WHEN status='pending' THEN amount ELSE 0 END),0)::numeric as pending_amount
       FROM deposit_requests WHERE created_at BETWEEN $1 AND $2`, [dateFrom, dateTo]);

    const withdrawals = await db.q(
      `SELECT COUNT(*)::int as total,
              COUNT(CASE WHEN status='pending' THEN 1 END)::int as pending,
              COUNT(CASE WHEN status='approved' THEN 1 END)::int as approved,
              COUNT(CASE WHEN status='rejected' THEN 1 END)::int as rejected,
              COALESCE(SUM(CASE WHEN status='approved' THEN amount ELSE 0 END),0)::numeric as approved_amount,
              COALESCE(SUM(CASE WHEN status='pending' THEN amount ELSE 0 END),0)::numeric as pending_amount
       FROM withdrawal_requests WHERE created_at BETWEEN $1 AND $2`, [dateFrom, dateTo]);

    const users = await db.q(
      `SELECT COUNT(*)::int as new_users FROM users WHERE created_at BETWEEN $1 AND $2`, [dateFrom, dateTo]);

    const totalUsers = await db.q(`SELECT COUNT(*)::int as count FROM users`);

    const dailyRevenue = await db.q(
      `SELECT DATE(started_at) as day,
              COUNT(*)::int as games,
              COALESCE(SUM(pot - COALESCE(win_amount,0)),0)::numeric as profit,
              COALESCE(SUM(pot),0)::numeric as pot
       FROM games WHERE status='finished' AND started_at BETWEEN $1 AND $2
       GROUP BY DATE(started_at) ORDER BY day ASC`, [dateFrom, dateTo]);

    const topWinners = await db.q(
      `SELECT u.name, u.phone,
              COUNT(CASE WHEN t.type='win' THEN 1 END)::int as wins,
              COALESCE(SUM(CASE WHEN t.type='win' THEN t.amount ELSE 0 END),0)::numeric as total_won
       FROM users u JOIN transactions t ON t.user_id=u.id
       WHERE t.created_at BETWEEN $1 AND $2 AND t.type='win'
       GROUP BY u.id, u.name, u.phone
       ORDER BY total_won DESC LIMIT 10`, [dateFrom, dateTo]);

    const recentTx = await db.q(
      `SELECT u.name, u.phone, t.type, t.amount, t.created_at
       FROM transactions t JOIN users u ON u.id=t.user_id
       WHERE t.created_at BETWEEN $1 AND $2
       ORDER BY t.created_at DESC LIMIT 20`, [dateFrom, dateTo]);

    const pendingDeposits = await db.q(
      `SELECT dr.id, dr.amount, dr.tx_ref, dr.created_at, u.name, u.phone
       FROM deposit_requests dr JOIN users u ON u.id=dr.user_id
       WHERE dr.status='pending' ORDER BY dr.created_at ASC LIMIT 20`);

    const pendingWithdrawals = await db.q(
      `SELECT wr.id, wr.amount, wr.created_at, u.name, u.phone
       FROM withdrawal_requests wr JOIN users u ON u.id=wr.user_id
       WHERE wr.status='pending' ORDER BY wr.created_at ASC LIMIT 20`);

    res.json({
      range: { from: dateFrom, to: dateTo },
      games: games[0],
      profit: profit[0],
      deposits: deposits[0],
      withdrawals: withdrawals[0],
      users: { ...users[0], total: totalUsers[0].count },
      dailyRevenue,
      topWinners,
      recentTx,
      pendingDeposits,
      pendingWithdrawals
    });
  } catch(e) {
    console.error('Analytics error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Payment info (Telebirr account shown on deposit page) ──
app.get('/api/payment-info', (req,res)=>{
  res.json(PAYMENT_INFO);
});
app.get('/api/admin/payment-settings', adminAuth, (req,res)=>{
  res.json(PAYMENT_INFO);
});
app.post('/api/admin/payment-settings', adminAuth, async(req,res)=>{
  const { telebirrNumber, telebirrName } = req.body || {};
  if(telebirrNumber && String(telebirrNumber).trim()) PAYMENT_INFO.telebirrNumber = String(telebirrNumber).trim();
  if(telebirrName && String(telebirrName).trim())     PAYMENT_INFO.telebirrName   = String(telebirrName).trim();
  if(db){
    try{
      await db.setSetting('telebirr_number', PAYMENT_INFO.telebirrNumber);
      await db.setSetting('telebirr_name',   PAYMENT_INFO.telebirrName);
    }catch(e){ console.error('⚠️ Settings save:', e.message); }
  }
  res.json({ ok:true, ...PAYMENT_INFO });
});

app.get('/api/leaderboard', async(req,res)=>{
  if(!db) return res.json([]);
  res.json(await db.getLeaderboard());
});

// ─── PROFILE (db.js: getBingoUserDashboard) ───────────────────
// get_bingo_user_dashboard(user_id) returns (see database.sql):
//   { status:'active'|'blocked'|'inactive', user:{...},
//     balances:[{wallet_type:'main'|'play'|'bonus', balance, ...}],
//     summary:{games_played, games_won, total_earned},
//     stakes:[{stake_id, amount, games_played, games_won, total_earned, rooms:[...]}] }
// Everything the profile needs is fetched ONCE per request, in parallel, and cached for 10 seconds
// (a round start / end clears the cache for the players involved).
let dashboardShapeLogged=false;
async function getBingoProfile(tid){
  const hit=profileCache.get(tid);
  if(hit&&Date.now()-hit.t<PROFILE_TTL_MS) return hit.data;

  const u=await loadUser(tid,3,300);
  if(!u||!u.userId) return null;

  const [dash,stats]=await Promise.all([
    bingoDb.getBingoUserDashboard(u.userId).catch(e=>{ console.error('getBingoUserDashboard:',e.message); return null; }),
    // counters straight from the game tables: only used for anything the dashboard could not give
    bingoDb.getBingoProfileStats(u.userId).catch(e=>{ console.error('getBingoProfileStats:',e.message); return null; })
  ]);
  const d=(dash&&typeof dash==='object')?dash:null;
  if(d&&!dashboardShapeLogged){ dashboardShapeLogged=true; console.log('ℹ️ getBingoUserDashboard keys:',Object.keys(d).join(', ')); }
  if(d&&d.status&&d.status!=='active') return {blocked:true,status:d.status};

  const num=v=>{const x=Number(v);return Number.isFinite(x)?x:undefined;};
  const walletOf=type=>{
    const row=(d&&Array.isArray(d.balances))?d.balances.find(b=>b&&b.wallet_type===type):null;
    return row?num(row.balance):undefined;
  };
  const wallets={
    main:round2(walletOf('main')??u.wallets.main),
    play:round2(walletOf('play')??u.wallets.play),
    bonus:round2(walletOf('bonus')??u.wallets.bonus)
  };
  if(Math.abs(wallets.main-u.wallets.main)>0.009||Math.abs(wallets.play-u.wallets.play)>0.009){
    console.warn(`⚠️ dashboard wallets differ from the wallet view for user ${u.userId}:`,wallets,u.wallets);
  }

  const sum=(d&&d.summary)||{};
  const games=num(sum.games_played)??stats?.games??0;
  const wins=num(sum.games_won)??stats?.wins??0;
  const earning=num(sum.total_earned)??stats?.earning??0;

  // one row per ACTIVE stake (even with 0 wins), straight from the dashboard
  let stakeRows=[];
  if(d&&Array.isArray(d.stakes)){
    stakeRows=d.stakes.map(st=>({
      stake:num(st.amount)||0,
      wins:Math.trunc(num(st.games_won)||0),
      win_amount:num(st.total_earned)||0
    })).filter(r=>r.stake>0).sort((a,b)=>a.stake-b.stake);
  }
  if(!stakeRows.length&&stats?.by_stake) stakeRows=stats.by_stake;

  const out={
    telegramId:String(tid),
    name:u.name||'',
    phone:u.phone||'',
    balance:round2(wallets.main+wallets.play),          // header amount (main + play)
    main_wallet:wallets.main,
    play_wallet:wallets.play,
    bonus:wallets.bonus,
    wallets,
    total_games:Math.max(0,Math.trunc(games)),
    total_wins:Math.max(0,Math.trunc(wins)),
    total_winnings:Math.max(0,earning),
    stake_stats:stakeRows,
    latest_earnings:0,
    isAdmin:u.isAdmin===true,
    source:{dashboard:!!d,stats:!!stats}
  };
  profileCache.set(tid,{t:Date.now(),data:out});
  return out;
}

app.get('/api/user/:tid', async(req,res)=>{
  const tid=String(req.params.tid||'').trim();
  if(!tid) return res.status(400).json({error:'Missing Telegram ID'});
  if(USE_BINGO_DB){
    try{
      const out=await getBingoProfile(tid);
      if(!out) return res.status(404).json({error:'Not found'});
      if(out.blocked) return res.status(403).json({error:`Account is ${out.status}`,status:out.status});
      return res.json(out);
    }catch(e){
      console.error('GET /api/user (db.js):',e.stack||e.message);
      return res.status(500).json({error:'Database query failed'});
    }
  }
  if(!db) return res.status(503).json({error:'Database unavailable'});

  try{
    // Keep the basic account query completely independent from game/statistics
    // queries. A statistics query must never prevent login/profile from loading.
    const rows=await db.q(
      `SELECT * FROM users WHERE telegram_id=$1 LIMIT 1`,
      [tid]
    );
    const u=rows[0]||null;
    if(!u) return res.status(404).json({error:'Not found'});

    // Always keep the database user's stored counters as the safe fallback.
    let totalGames=Math.max(0,Number(u.total_games)||0);
    let totalWins=Math.max(0,Number(u.total_wins)||0);
    let latestEarnings=0;

    // Calculate games played independently through stake transactions. This is
    // the same relationship used by the existing game-history endpoint and does
    // not depend on game_participants being present/correct.
    try{
      const r=await db.q(`
        SELECT COUNT(DISTINCT g.id)::int AS total_games
        FROM games g
        JOIN transactions t ON t.reference=g.room_id
        JOIN users tu ON tu.id=t.user_id
        WHERE tu.telegram_id=$1
          AND g.status='finished'
          AND t.type='stake'
      `,[tid]);
      const computed=Math.max(0,Number(r[0]?.total_games)||0);
      totalGames=Math.max(totalGames,computed);
    }catch(e){
      console.error('Profile games query:',e.message);
    }

    // Calculate wins directly from finished games. If the winner column cannot
    // be queried for any reason, retain the authoritative users.total_wins value.
    try{
      const r=await db.q(`
        SELECT COUNT(*)::int AS total_wins
        FROM games
        WHERE status='finished'
          AND $1 = ANY(winner_ids)
      `,[tid]);
      const computed=Math.max(0,Number(r[0]?.total_wins)||0);
      totalWins=Math.max(totalWins,computed);
    }catch(e){
      console.error('Profile wins query:',e.message);
    }

    try{
      const r=await db.q(`
        SELECT win_amount
        FROM games
        WHERE status='finished'
          AND $1 = ANY(winner_ids)
        ORDER BY ended_at DESC NULLS LAST, id DESC
        LIMIT 1
      `,[tid]);
      latestEarnings=Math.max(0,Number(r[0]?.win_amount)||0);
    }catch(e){
      console.error('Profile latest earnings query:',e.message);
    }

    // Keep stored totals synchronized when our safe calculations find more data.
    if(totalGames !== Math.max(0,Number(u.total_games)||0)){
      try{
        await db.q('UPDATE users SET total_games=$1 WHERE id=$2',[totalGames,u.id]);
      }catch(e){
        console.error('Profile total_games sync:',e.message);
      }
    }
    if(totalWins !== Math.max(0,Number(u.total_wins)||0)){
      try{
        await db.q('UPDATE users SET total_wins=$1 WHERE id=$2',[totalWins,u.id]);
      }catch(e){
        console.error('Profile total_wins sync:',e.message);
      }
    }

    // Wins by stake for the profile table (5 / 10 / 20): number of games won and total won.
    // Kept in its own try/catch so a statistics problem can never break login or the profile.
    let stakeStats=[];
    try{
      const r=await db.q(`
        SELECT g.stake_amount::numeric AS stake,
               COUNT(*)::int AS wins,
               COALESCE(SUM(g.win_amount),0)::numeric AS win_amount
        FROM games g
        WHERE g.status='finished'
          AND $1 = ANY(COALESCE(g.winner_ids, ARRAY[]::text[]))
        GROUP BY g.stake_amount
        ORDER BY g.stake_amount
      `,[tid]);
      stakeStats=r.map(x=>({stake:Number(x.stake)||0,wins:Number(x.wins)||0,win_amount:Number(x.win_amount)||0}));
    }catch(e){
      console.error('Profile stake stats query:',e.message);
    }

    const user={
      telegramId:String(u.telegram_id),
      name:u.name||'',
      phone:u.phone||'',
      balance:Number.parseFloat(u.balance)||0,
      total_games:totalGames,
      total_wins:totalWins,
      total_winnings:Math.max(0,Number(u.total_winnings)||0),
      // Optional wallets: shown on the profile if the users table has these columns, else 0.
      play_wallet:Math.max(0,Number.parseFloat(u.play_wallet ?? u.play_balance)||0),
      bonus:Math.max(0,Number.parseFloat(u.bonus ?? u.bonus_balance)||0),
      stake_stats:stakeStats,
      latest_earnings:latestEarnings,
      isAdmin:u.is_admin===true || isAdminPhone(u.phone)
    };

    userCache[tid]={...(userCache[tid]||{}),...user};
    res.json(user);
  }catch(e){
    console.error('GET /api/user error:',e.stack||e.message);
    res.status(500).json({error:'Database query failed'});
  }
});


app.get('/api/history/:tid', async(req,res)=>{
  const tid=String(req.params.tid||'').trim();
  if(!tid) return res.status(400).json({error:'Missing Telegram ID'});
  if(!db) return res.status(503).json({error:'Database unavailable'});
  try{
    const rows=await db.getGameHistory(tid, req.query.limit);
    res.json(rows);
  }catch(e){
    console.error('GET /api/history error:',e.message);
    res.status(500).json({error:'Could not load game history'});
  }
});

// ─── START ────────────────────────────────────────────────────
server.listen(PORT,()=>{
  console.log(`\n🎱 Beteseb Bingo v5 on port ${PORT}\n`);
  startTelegramBot();
});

// ─── BOT ─────────────────────────────────────────────────────
// ─── BOT ─────────────────────────────────────────────────────
function startTelegramBot(){
  const TOKEN=process.env.BOT_TOKEN, GAME_URL=process.env.GAME_URL||'https://beteseb-bingo.onrender.com';
  if(!TOKEN){console.log('ℹ️ No BOT_TOKEN');return;}
  let Bot; try{Bot=require('node-telegram-bot-api');}catch(e){console.log('ℹ️ Bot lib missing');return;}
  const bot=new Bot(TOKEN,{polling:true}), pending={};

  const MAIN_MENU = {
    keyboard: [
      [{ text: '🎮 Play Now' }, { text: '📝 Register' }],
      [{ text: '💰 Deposit' }, { text: '💸 Withdraw' }],
      [{ text: '🔀 Transfer' }, { text: '🎁 Invite Friends' }],
      [{ text: '🎯 Game Patterns' }, { text: '📖 Instructions' }],
      [{ text: '🆘 24H Support 1' }, { text: '🆘 Support 2' }]
    ],
    resize_keyboard: true,
    persistent: true
  };

 async function showMainMenu(chatId, tid, firstName){
  const user = await loadUser(String(tid));
  if(user){
    bot.sendMessage(chatId,
      `👋 Hi *${user.name}!*\nWelcome to *Beteseb Bingo*, the ultimate bingo gaming experience! 🎉\n\n💰 Balance: *${parseFloat(user.balance).toFixed(2)} ETB*`,
      { parse_mode:'Markdown', reply_markup: MAIN_MENU }
    );
  } else {
    pending[tid] = { step:'ask_phone', name: firstName || 'Player' };
    bot.sendMessage(chatId,
      `👋 Hi *${firstName || 'Player'}!*\nWelcome to *Beteseb Bingo!* 🎱\n\nPlease share your phone number to register:`,
      { parse_mode:'Markdown', reply_markup:{ keyboard:[[{ text:'📱 Share Phone Number', request_contact:true }]], resize_keyboard:true, one_time_keyboard:true }}
    );
  }
}

  bot.onText(/\/start/, msg => showMainMenu(msg.chat.id, msg.from.id, msg.from.first_name));
bot.onText(/\/play/,  msg => showMainMenu(msg.chat.id, msg.from.id, msg.from.first_name));

  bot.onText(/\/balance/, async msg => {
    const u = await loadUser(String(msg.from.id));
    bot.sendMessage(msg.chat.id,
      u ? `💰 Balance: *${parseFloat(u.balance).toFixed(2)} ETB*` : 'Use /start to register.',
      { parse_mode:'Markdown', reply_markup: MAIN_MENU }
    );
  });

  bot.on('message', async msg => {
    const tid = msg.from.id;
    const text = msg.text || '';

    // ── Handle registration flow ──
    const p = pending[tid];
    if(p && !text.startsWith('/')){
      if(p.step === 'ask_name'){
        p.name = text.trim().substring(0,30);
        p.step = 'ask_phone';
        bot.sendMessage(msg.chat.id,
          `Nice to meet you *${p.name}!* 👋\n\nPlease Share Your Phone Number:`,
          { parse_mode:'Markdown', reply_markup:{ keyboard:[[{ text:'📱 Share Phone Number', request_contact:true }]], resize_keyboard:true, one_time_keyboard:true }}
        );
      }
      return;
    }

    // ── Handle menu button presses ──
    const user = await loadUser(String(tid));

    if(text === '🎮 Play Now'){
      if(!user) return bot.sendMessage(msg.chat.id, '⚠️ Please register first by pressing 📝 Register.', { reply_markup: MAIN_MENU });
      bot.sendMessage(msg.chat.id, `🎮 Tap below to open the game:`, {
        reply_markup:{
          inline_keyboard:[[{ text:'🎮 Play Beteseb Bingo', web_app:{ url:`${GAME_URL}?tid=${tid}` }}]]
        }
      });
    }

    else if(text === '📝 Register'){
      if(user) return bot.sendMessage(msg.chat.id, `✅ You are already registered as *${user.name}!*\n💰 Balance: *${parseFloat(user.balance).toFixed(2)} ETB*`, { parse_mode:'Markdown', reply_markup: MAIN_MENU });
      pending[tid] = { step:'ask_name' };
      bot.sendMessage(msg.chat.id, '📝 Let\'s get you registered!\n\nWhat should we call you?', { reply_markup: MAIN_MENU });
    }

    else if(text === '💰 Deposit'){
      if(!user) return bot.sendMessage(msg.chat.id, '⚠️ Please register first.', { reply_markup: MAIN_MENU });
      bot.sendMessage(msg.chat.id, `💰 Tap below to deposit:`, {
        reply_markup:{
          inline_keyboard:[[{ text:'💰 Deposit Now', web_app:{ url:`${GAME_URL}?tid=${tid}&page=deposit` }}]]
        }
      });
    }

    else if(text === '💸 Withdraw'){
      if(!user) return bot.sendMessage(msg.chat.id, '⚠️ Please register first.', { reply_markup: MAIN_MENU });
      bot.sendMessage(msg.chat.id, `💸 Tap below to withdraw:`, {
        reply_markup:{
          inline_keyboard:[[{ text:'💸 Withdraw Now', web_app:{ url:`${GAME_URL}?tid=${tid}&page=withdraw` }}]]
        }
      });
    }

    else if(text === '🔀 Transfer'){
      bot.sendMessage(msg.chat.id,
        `🔀 *Transfer*\n\nPlayer-to-player transfer is coming soon! Stay tuned 🚀`,
        { parse_mode:'Markdown', reply_markup: MAIN_MENU }
      );
    }

    else if(text === '🎁 Invite Friends'){
      const me = await bot.getMe();
      const link = `https://t.me/${me.username}?start=ref_${tid}`;
      bot.sendMessage(msg.chat.id,
        `🎁 *Invite Friends & Earn!*\n\nShare your link:\n${link}\n\n_Coming soon: earn bonus ETB for every friend who joins!_`,
        { parse_mode:'Markdown', reply_markup: MAIN_MENU }
      );
    }

    else if(text === '🎯 Game Patterns'){
      bot.sendMessage(msg.chat.id,
        `🎯 *Winning Patterns*\n\n✅ Any complete *row* (horizontal)\n✅ Any complete *column* (vertical)\n✅ Either *diagonal*\n✅ *4 corners*\n\nThe FREE space in the center counts automatically!\n\nPress BINGO as soon as you complete a pattern! 🎉`,
        { parse_mode:'Markdown', reply_markup: MAIN_MENU }
      );
    }

    else if(text === '📖 Instructions'){
      bot.sendMessage(msg.chat.id,
        `📖 *How to Play Beteseb Bingo*\n\n1️⃣ Deposit ETB into your wallet\n2️⃣ Choose a stake tier (10–100 ETB)\n3️⃣ Pick your lucky card (1–400)\n4️⃣ Numbers are called every 5 seconds\n5️⃣ Mark numbers on your card\n6️⃣ Complete a pattern and press *BINGO!* 🎉\n\n🏆 Winner gets *80%* of the total pot\n🏠 House takes *20%*\n⚠️ False BINGO = disqualification!`,
        { parse_mode:'Markdown', reply_markup: MAIN_MENU }
      );
    }

    else if(text === '🆘 24H Support 1'){
      bot.sendMessage(msg.chat.id,
        `🆘 *24H Support*\n\nContact us anytime:\n👤 @YourSupportUsername1\n\nWe typically respond within a few minutes.`,
        { parse_mode:'Markdown', reply_markup: MAIN_MENU }
      );
    }

    else if(text === '🆘 Support 2'){
      bot.sendMessage(msg.chat.id,
        `🆘 *Support 2*\n\nAlternate support contact:\n👤 @YourSupportUsername2`,
        { parse_mode:'Markdown', reply_markup: MAIN_MENU }
      );
    }
  });

bot.on('contact', async msg => {
    const tid = msg.from.id, p = pending[tid];
    if(!p) return;
    if(USE_BINGO_DB){ bot.sendMessage(msg.chat.id,'Please register with the main Mela Bingo bot first, then open the game again.'); delete pending[tid]; return; }
    const phone = (msg.contact.phone_number||'').replace(/^\+/,'');
    const name  = msg.contact.first_name || msg.from.first_name || 'Player';
    delete pending[tid];
    let balance = 0;
    if(db){
      try{
        const u = await db.createUser(String(tid), name, phone);
        balance = parseFloat(u.balance);
        userCache[String(tid)] = { name, phone, balance, isAdmin: isAdminPhone(phone) };
      } catch(e){ console.error('createUser error:', e.message); }
    } else {
      userCache[String(tid)] = { name, phone, balance:0, isAdmin: isAdminPhone(phone) };
    }
    bot.sendMessage(msg.chat.id,
      `✅ *Registered Successfully!*\n\n👤 Name: *${name}*\n📱 Phone: ${phone}\n💰 Balance: *${balance} ETB*\n\nDeposit ETB to start playing! 🎱`,
      { parse_mode:'Markdown', reply_markup: MAIN_MENU }
    );
  });

  console.log('🤖 Telegram bot started!!');
}
