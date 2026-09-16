-- ════════════════════════════════════════════════════════════════
--  BETESEB BINGO — PostgreSQL Database Schema
--  Run this file once to set up all tables
--  Command: psql -U postgres -d beteseb_bingo -f database.sql
-- ════════════════════════════════════════════════════════════════

CREATE DATABASE beteseb_bingo;
\c beteseb_bingo;

--
-- PostgreSQL database dump
--

-- Dumped from database version 18.6 (2078fcb)
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: award_win(integer, numeric, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.award_win(p_user_id integer, p_amount numeric, p_game_id integer) RETURNS numeric
    LANGUAGE plpgsql
    AS $$
DECLARE v_new_balance NUMERIC;
BEGIN
  UPDATE users
  SET balance = balance + p_amount,
      total_wins = total_wins + 1,
      total_winnings = total_winnings + p_amount
  WHERE id = p_user_id
  RETURNING balance INTO v_new_balance;

  INSERT INTO transactions(user_id, type, amount, balance_after, reference)
  VALUES(p_user_id, 'win', p_amount, v_new_balance, p_game_id::TEXT);

  RETURN v_new_balance;
END;
$$;


--
-- Name: deduct_stake(integer, numeric, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.deduct_stake(p_user_id integer, p_amount numeric, p_game_id integer) RETURNS numeric
    LANGUAGE plpgsql
    AS $$
DECLARE v_new_balance NUMERIC;
BEGIN
  UPDATE users SET balance = balance - p_amount
  WHERE id = p_user_id AND balance >= p_amount
  RETURNING balance INTO v_new_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient balance';
  END IF;

  INSERT INTO transactions(user_id, type, amount, balance_after, reference)
  VALUES(p_user_id, 'stake', -p_amount, v_new_balance, p_game_id::TEXT);

  RETURN v_new_balance;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id integer NOT NULL,
    telegram_id bigint NOT NULL,
    name character varying(50) NOT NULL,
    phone character varying(20),
    balance numeric(10,2),
    total_games integer DEFAULT 0,
    total_wins integer DEFAULT 0,
    total_winnings numeric(10,2) DEFAULT 0,
    is_banned boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    last_seen timestamp with time zone DEFAULT now(),
    is_active boolean DEFAULT true,
    is_admin boolean DEFAULT false NOT NULL,
    admin_role character varying(20),
    is_blocked boolean DEFAULT false NOT NULL,
    CONSTRAINT users_admin_role_check CHECK (((admin_role IS NULL) OR ((admin_role)::text = ANY ((ARRAY['main'::character varying, 'statistics'::character varying, 'withdrawal'::character varying, 'broadcast'::character varying])::text[]))))
);


--
-- Name: register_user(bigint, character varying, character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.register_user(p_telegram_id bigint, p_name character varying, p_phone character varying) RETURNS public.users
    LANGUAGE plpgsql
    AS $$
DECLARE v_user users;
BEGIN
  INSERT INTO users(telegram_id, name, phone)
  VALUES(p_telegram_id, p_name, p_phone)
  ON CONFLICT(telegram_id) DO UPDATE SET last_seen=NOW()
  RETURNING * INTO v_user;
  RETURN v_user;
END;
$$;


--
-- Name: broadcast_drafts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.broadcast_drafts (
    admin_id bigint NOT NULL,
    image_url text,
    message text,
    status character varying(50) DEFAULT 'waiting_image'::character varying,
    created_at timestamp without time zone DEFAULT now(),
    button_title text,
    include_image boolean DEFAULT false NOT NULL,
    include_text boolean DEFAULT false NOT NULL,
    include_button boolean DEFAULT false NOT NULL
);


--
-- Name: payment_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_accounts (
    id integer CONSTRAINT deposit_accounts_id_not_null NOT NULL,
    payment_method_id integer CONSTRAINT deposit_accounts_payment_method_id_not_null NOT NULL,
    account_name character varying(100),
    account_number character varying(100),
    balance numeric(10,2) DEFAULT 0.00 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    is_removed boolean DEFAULT false CONSTRAINT payment_accounts_permanently_removed_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: deposit_accounts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.deposit_accounts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: deposit_accounts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.deposit_accounts_id_seq OWNED BY public.payment_accounts.id;


--
-- Name: deposits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deposits (
    id integer CONSTRAINT deposit_id_not_null NOT NULL,
    user_id integer CONSTRAINT deposit_user_id_not_null NOT NULL,
    payment_account_id integer CONSTRAINT deposit_payment_account_id_not_null NOT NULL,
    deposit_method_id integer CONSTRAINT deposit_deposit_method_id_not_null NOT NULL,
    depositor_name character varying(100),
    depositor_account character varying(20),
    amount numeric(10,2),
    amount_after numeric(10,2),
    reference character varying(100),
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: deposit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.deposit_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: deposit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.deposit_id_seq OWNED BY public.deposits.id;


--
-- Name: game_participants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.game_participants (
    id integer NOT NULL,
    game_id integer,
    user_id integer,
    card_id integer NOT NULL,
    is_winner boolean DEFAULT false,
    is_disqualified boolean DEFAULT false,
    amount_won numeric(10,2) DEFAULT 0,
    joined_at timestamp with time zone DEFAULT now()
);


--
-- Name: game_participants_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.game_participants_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: game_participants_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.game_participants_id_seq OWNED BY public.game_participants.id;


--
-- Name: games; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.games (
    id integer NOT NULL,
    room_id uuid NOT NULL,
    stake_id character varying(10) NOT NULL,
    stake_amount numeric(10,2) NOT NULL,
    pot numeric(10,2) NOT NULL,
    status character varying(20) DEFAULT 'waiting'::character varying,
    called_numbers integer[] DEFAULT '{}'::integer[],
    winner_ids integer[] DEFAULT '{}'::integer[],
    win_amount numeric(10,2) DEFAULT 0,
    is_split boolean DEFAULT false,
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: games_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.games_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: games_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.games_id_seq OWNED BY public.games.id;


--
-- Name: leaderboard; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.leaderboard AS
 SELECT id,
    name,
    telegram_id,
    total_wins,
    total_games,
    total_winnings,
    round((((total_wins)::numeric / (NULLIF(total_games, 0))::numeric) * (100)::numeric), 1) AS win_rate
   FROM public.users u
  ORDER BY total_winnings DESC;


--
-- Name: payment_methods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_methods (
    id integer NOT NULL,
    type_id integer NOT NULL,
    name character varying(100) NOT NULL,
    amharic_name character varying(100) NOT NULL,
    emoji character varying(20),
    "order" integer NOT NULL,
    is_active boolean NOT NULL
);


--
-- Name: payment_methods_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.payment_methods_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payment_methods_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.payment_methods_id_seq OWNED BY public.payment_methods.id;


--
-- Name: payment_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_types (
    id integer CONSTRAINT payment_type_id_not_null NOT NULL,
    name character varying(20) CONSTRAINT payment_type_name_not_null NOT NULL,
    amharic_name character varying(20) NOT NULL,
    emoji character varying(20),
    maximum_balance numeric(10,2),
    "order" integer,
    is_active boolean
);


--
-- Name: payment_type_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.payment_type_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payment_type_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.payment_type_id_seq OWNED BY public.payment_types.id;


--
-- Name: settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settings (
    key text NOT NULL,
    value text
);


--
-- Name: transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transactions (
    id integer NOT NULL,
    user_id integer,
    type character varying(20) NOT NULL,
    amount numeric(10,2) NOT NULL,
    balance_after numeric(10,2) NOT NULL,
    reference character varying(100),
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.transactions_id_seq OWNED BY public.transactions.id;


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: withdrawals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.withdrawals (
    id integer CONSTRAINT "withdrawals _id_not_null" NOT NULL,
    user_id integer CONSTRAINT "withdrawals _user_id_not_null" NOT NULL,
    payment_method_id integer,
    payment_account_id integer,
    approved_by_id integer,
    account_number character varying(20),
    amount numeric(10,2),
    is_pending boolean DEFAULT true NOT NULL,
    is_approved boolean DEFAULT false NOT NULL,
    reject_reason character varying(100),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT withdrawals_status_check CHECK ((((is_pending = true) AND (is_approved = false)) OR ((is_pending = false) AND (is_approved = true)) OR ((is_pending = false) AND (is_approved = false))))
);


--
-- Name: withdrawals _id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."withdrawals _id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: withdrawals _id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."withdrawals _id_seq" OWNED BY public.withdrawals.id;


--
-- Name: deposits id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deposits ALTER COLUMN id SET DEFAULT nextval('public.deposit_id_seq'::regclass);


--
-- Name: game_participants id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_participants ALTER COLUMN id SET DEFAULT nextval('public.game_participants_id_seq'::regclass);


--
-- Name: games id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.games ALTER COLUMN id SET DEFAULT nextval('public.games_id_seq'::regclass);


--
-- Name: payment_accounts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_accounts ALTER COLUMN id SET DEFAULT nextval('public.deposit_accounts_id_seq'::regclass);


--
-- Name: payment_methods id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_methods ALTER COLUMN id SET DEFAULT nextval('public.payment_methods_id_seq'::regclass);


--
-- Name: payment_types id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_types ALTER COLUMN id SET DEFAULT nextval('public.payment_type_id_seq'::regclass);


--
-- Name: transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions ALTER COLUMN id SET DEFAULT nextval('public.transactions_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: withdrawals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.withdrawals ALTER COLUMN id SET DEFAULT nextval('public."withdrawals _id_seq"'::regclass);


--
-- Name: broadcast_drafts broadcast_drafts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.broadcast_drafts
    ADD CONSTRAINT broadcast_drafts_pkey PRIMARY KEY (admin_id);


--
-- Name: payment_accounts deposit_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_accounts
    ADD CONSTRAINT deposit_accounts_pkey PRIMARY KEY (id);


--
-- Name: deposits deposit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deposits
    ADD CONSTRAINT deposit_pkey PRIMARY KEY (id);


--
-- Name: game_participants game_participants_game_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_participants
    ADD CONSTRAINT game_participants_game_id_user_id_key UNIQUE (game_id, user_id);


--
-- Name: game_participants game_participants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_participants
    ADD CONSTRAINT game_participants_pkey PRIMARY KEY (id);


--
-- Name: games games_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.games
    ADD CONSTRAINT games_pkey PRIMARY KEY (id);


--
-- Name: payment_methods payment_methods_amharic_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_methods
    ADD CONSTRAINT payment_methods_amharic_name_key UNIQUE (amharic_name);


--
-- Name: payment_methods payment_methods_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_methods
    ADD CONSTRAINT payment_methods_name_key UNIQUE (name);


--
-- Name: payment_methods payment_methods_order_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_methods
    ADD CONSTRAINT payment_methods_order_key UNIQUE ("order");


--
-- Name: payment_methods payment_methods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_methods
    ADD CONSTRAINT payment_methods_pkey PRIMARY KEY (id);


--
-- Name: payment_types payment_type_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_types
    ADD CONSTRAINT payment_type_name_key UNIQUE (name);


--
-- Name: payment_types payment_type_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_types
    ADD CONSTRAINT payment_type_pkey PRIMARY KEY (id);


--
-- Name: settings settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (key);


--
-- Name: transactions transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_pkey PRIMARY KEY (id);


--
-- Name: users users_phone_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_phone_unique UNIQUE (phone);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_telegram_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_telegram_id_key UNIQUE (telegram_id);


--
-- Name: withdrawals withdrawals _pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.withdrawals
    ADD CONSTRAINT "withdrawals _pkey" PRIMARY KEY (id);


--
-- Name: deposits_reference_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX deposits_reference_unique_idx ON public.deposits USING btree (reference) WHERE (reference IS NOT NULL);


--
-- Name: idx_deposits_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deposits_created_at ON public.deposits USING btree (created_at DESC);


--
-- Name: idx_deposits_payment_account_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deposits_payment_account_id ON public.deposits USING btree (payment_account_id);


--
-- Name: idx_deposits_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deposits_user_id ON public.deposits USING btree (user_id);


--
-- Name: idx_games_room; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_games_room ON public.games USING btree (room_id);


--
-- Name: idx_games_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_games_status ON public.games USING btree (status);


--
-- Name: idx_participants_game; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_participants_game ON public.game_participants USING btree (game_id);


--
-- Name: idx_participants_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_participants_user ON public.game_participants USING btree (user_id);


--
-- Name: idx_payment_accounts_method_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_accounts_method_active ON public.payment_accounts USING btree (payment_method_id, is_active, is_removed);


--
-- Name: idx_transactions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_user ON public.transactions USING btree (user_id);


--
-- Name: idx_users_admin_role_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_admin_role_active ON public.users USING btree (admin_role, is_active, is_banned, is_blocked) WHERE (is_admin = true);


--
-- Name: idx_users_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_phone ON public.users USING btree (phone);


--
-- Name: idx_users_telegram; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_telegram ON public.users USING btree (telegram_id);


--
-- Name: idx_withdrawals_pending_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_withdrawals_pending_created ON public.withdrawals USING btree (is_pending, is_approved, created_at);


--
-- Name: idx_withdrawals_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_withdrawals_user_id ON public.withdrawals USING btree (user_id);


--
-- Name: payment_accounts deposit_accounts_payment_method_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_accounts
    ADD CONSTRAINT deposit_accounts_payment_method_id_fkey FOREIGN KEY (payment_method_id) REFERENCES public.payment_methods(id);


--
-- Name: deposits deposit_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deposits
    ADD CONSTRAINT deposit_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: deposits deposits_payment_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deposits
    ADD CONSTRAINT deposits_payment_account_id_fkey FOREIGN KEY (payment_account_id) REFERENCES public.payment_accounts(id);


--
-- Name: deposits deposits_payment_method_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deposits
    ADD CONSTRAINT deposits_payment_method_id_fkey FOREIGN KEY (deposit_method_id) REFERENCES public.payment_methods(id);


--
-- Name: game_participants game_participants_game_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_participants
    ADD CONSTRAINT game_participants_game_id_fkey FOREIGN KEY (game_id) REFERENCES public.games(id) ON DELETE CASCADE;


--
-- Name: game_participants game_participants_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_participants
    ADD CONSTRAINT game_participants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: payment_methods payment_methods_type_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_methods
    ADD CONSTRAINT payment_methods_type_fkey FOREIGN KEY (type_id) REFERENCES public.payment_types(id);


--
-- Name: transactions transactions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--







