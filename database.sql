--
-- PostgreSQL database dump
--

-- Dumped from database version 18.6 (6569466)
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
-- Name: create_financial_transaction(integer, character varying, character varying, bigint, character varying, character varying, character varying, text, jsonb); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.create_financial_transaction(p_user_id integer, p_type character varying, p_status character varying DEFAULT 'completed'::character varying, p_game_system_id bigint DEFAULT NULL::bigint, p_source_type character varying DEFAULT NULL::character varying, p_source_id character varying DEFAULT NULL::character varying, p_idempotency_key character varying DEFAULT NULL::character varying, p_description text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_transaction_id BIGINT;
BEGIN

    /*
     * Atomic idempotency.
     *
     * If another request already created the same transaction,
     * return that transaction instead of creating another one.
     */
    INSERT INTO financial_transactions (
        user_id,
        type,
        status,
        game_system_id,
        source_type,
        source_id,
        idempotency_key,
        description,
        metadata,
        created_at,
        completed_at
    )
    VALUES (
        p_user_id,
        p_type,
        p_status,
        p_game_system_id,
        p_source_type,
        p_source_id,
        p_idempotency_key,
        p_description,
        COALESCE(p_metadata, '{}'::jsonb),
        NOW(),
        CASE
            WHEN p_status = 'completed'
            THEN NOW()
            ELSE NULL
        END
    )

    ON CONFLICT (idempotency_key)
    WHERE idempotency_key IS NOT NULL
    DO UPDATE SET
        id = financial_transactions.id

    RETURNING id
    INTO v_transaction_id;

    RETURN v_transaction_id;
END;
$$;


ALTER FUNCTION public.create_financial_transaction(p_user_id integer, p_type character varying, p_status character varying, p_game_system_id bigint, p_source_type character varying, p_source_id character varying, p_idempotency_key character varying, p_description text, p_metadata jsonb) OWNER TO neondb_owner;

--
-- Name: create_user_wallets(); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.create_user_wallets() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    main_wallet_id BIGINT;
    play_wallet_id BIGINT;
BEGIN

    -- MAIN WALLET
    INSERT INTO wallets (
        user_id,
        wallet_type,
        currency,
        is_active
    )
    VALUES (
        NEW.id,
        'main',
        'ETB',
        TRUE
    )
    ON CONFLICT (user_id, wallet_type)
    DO UPDATE
        SET is_active = TRUE
    RETURNING id INTO main_wallet_id;


    -- PLAY WALLET
    INSERT INTO wallets (
        user_id,
        wallet_type,
        currency,
        is_active
    )
    VALUES (
        NEW.id,
        'play',
        'ETB',
        TRUE
    )
    ON CONFLICT (user_id, wallet_type)
    DO UPDATE
        SET is_active = TRUE
    RETURNING id INTO play_wallet_id;


    -- MAIN BALANCE
    INSERT INTO wallet_balances (
        wallet_id,
        balance
    )
    VALUES (
        main_wallet_id,
        0
    )
    ON CONFLICT (wallet_id)
    DO NOTHING;


    -- PLAY BALANCE
    INSERT INTO wallet_balances (
        wallet_id,
        balance
    )
    VALUES (
        play_wallet_id,
        0
    )
    ON CONFLICT (wallet_id)
    DO NOTHING;


    RETURN NEW;
END;
$$;


ALTER FUNCTION public.create_user_wallets() OWNER TO neondb_owner;

--
-- Name: credit_deposit_to_wallet(integer, numeric, bigint, character varying, bigint, text); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.credit_deposit_to_wallet(p_user_id integer, p_amount numeric, p_deposit_id bigint, p_idempotency_key character varying DEFAULT NULL::character varying, p_game_system_id bigint DEFAULT NULL::bigint, p_description text DEFAULT NULL::text) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_wallet_id BIGINT;
    v_transaction_id BIGINT;
    v_existing_transaction BIGINT;
    v_amount NUMERIC(18,2);
BEGIN

    v_amount := ROUND(p_amount, 2);

    IF v_amount <= 0 THEN
        RAISE EXCEPTION 'Deposit amount must be greater than zero';
    END IF;


    -- Idempotency
    IF p_idempotency_key IS NOT NULL THEN

        SELECT id
        INTO v_existing_transaction
        FROM financial_transactions
        WHERE idempotency_key = p_idempotency_key
        LIMIT 1;

        IF v_existing_transaction IS NOT NULL THEN
            RETURN v_existing_transaction;
        END IF;

    END IF;


    v_wallet_id :=
        get_user_wallet_id(
            p_user_id,
            'play'
        );


    -- Lock wallet balance
    PERFORM lock_wallet(v_wallet_id);


    v_transaction_id :=
        create_financial_transaction(
            p_user_id,
            'deposit',
            'completed',
            p_game_system_id,
            'deposit',
            p_deposit_id::VARCHAR,
            p_idempotency_key,
            p_description,
            jsonb_build_object(
                'deposit_id',
                p_deposit_id
            )
        );


    INSERT INTO ledger_entries (
        transaction_id,
        wallet_id,
        amount
    )
    VALUES (
        v_transaction_id,
        v_wallet_id,
        v_amount
    );


    UPDATE wallet_balances
    SET balance = balance + v_amount,
        updated_at = NOW()
    WHERE wallet_id = v_wallet_id;


    RETURN v_transaction_id;
END;
$$;


ALTER FUNCTION public.credit_deposit_to_wallet(p_user_id integer, p_amount numeric, p_deposit_id bigint, p_idempotency_key character varying, p_game_system_id bigint, p_description text) OWNER TO neondb_owner;

--
-- Name: end_bingo_game(integer, integer[]); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.end_bingo_game(p_game_id integer, p_winner_card_ids integer[]) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_game bingo_games%ROWTYPE;

    v_winner_count integer;
    v_pot numeric(18,2);

    v_base_payout numeric(18,2);
    v_remainder_cents integer;

    v_game_system_id bigint;

    v_winner record;

    v_winner_user_ids integer[];

    v_total_payout numeric(18,2) := 0;
BEGIN

    ----------------------------------------------------------------
    -- 1. Validate input
    ----------------------------------------------------------------

    IF p_game_id IS NULL OR p_game_id <= 0 THEN
        RAISE EXCEPTION 'Invalid Bingo game ID';
    END IF;

    IF p_winner_card_ids IS NULL
       OR cardinality(p_winner_card_ids) = 0 THEN
        RAISE EXCEPTION
            'At least one winning card is required';
    END IF;


    ----------------------------------------------------------------
    -- 2. Remove duplicate card IDs
    --
    -- Duplicate cards should never be processed twice.
    ----------------------------------------------------------------

    p_winner_card_ids := ARRAY(
        SELECT DISTINCT card_id
        FROM unnest(p_winner_card_ids) AS card_id
        WHERE card_id IS NOT NULL
          AND card_id > 0
        ORDER BY card_id
    );

    IF cardinality(p_winner_card_ids) = 0 THEN
        RAISE EXCEPTION
            'No valid winning card IDs supplied';
    END IF;


    ----------------------------------------------------------------
    -- 3. Lock the game
    ----------------------------------------------------------------

    SELECT *
    INTO v_game
    FROM bingo_games
    WHERE id = p_game_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Bingo game % not found',
            p_game_id;
    END IF;


    ----------------------------------------------------------------
    -- 4. Game must still be active
    ----------------------------------------------------------------

    IF v_game.status = 'completed' THEN
        RAISE EXCEPTION
            'Bingo game % has already ended',
            p_game_id;
    END IF;

    IF v_game.status NOT IN ('waiting', 'playing') THEN
        RAISE EXCEPTION
            'Cannot end Bingo game % with status %',
            p_game_id,
            v_game.status;
    END IF;


    ----------------------------------------------------------------
    -- 5. Game must have participants
    ----------------------------------------------------------------

    IF NOT EXISTS (
        SELECT 1
        FROM bingo_participants
        WHERE game_id = p_game_id
    ) THEN
        RAISE EXCEPTION
            'Cannot end Bingo game % without participants',
            p_game_id;
    END IF;


    ----------------------------------------------------------------
    -- 6. Validate winning cards
    --
    -- Every supplied card:
    --   - must belong to this game
    --   - must be active
    --   - must not be disqualified
    --   - must not already be a winner
    ----------------------------------------------------------------

    IF EXISTS (
        SELECT 1
        FROM unnest(p_winner_card_ids) AS x(card_id)
        LEFT JOIN bingo_participants bp
          ON bp.game_id = p_game_id
         AND bp.card_id = x.card_id
        WHERE bp.id IS NULL
           OR bp.status <> 'active'
           OR bp.is_disqualified = TRUE
           OR bp.is_winner = TRUE
    ) THEN
        RAISE EXCEPTION
            'One or more winning cards are invalid for Bingo game %',
            p_game_id;
    END IF;


    ----------------------------------------------------------------
    -- 7. Lock all participants
    ----------------------------------------------------------------

    PERFORM 1
    FROM bingo_participants
    WHERE game_id = p_game_id
    FOR UPDATE;


    ----------------------------------------------------------------
    -- 8. Validate the pot
    --
    -- Only active cards contribute to the pot.
    ----------------------------------------------------------------

    SELECT COALESCE(
        SUM(amount),
        0
    )
    INTO v_pot
    FROM bingo_participants
    WHERE game_id = p_game_id
      AND status = 'active';

    v_pot := ROUND(v_pot, 2);

    IF v_pot <> ROUND(v_game.pot, 2) THEN
        RAISE EXCEPTION
            'Bingo pot mismatch. Game pot: %, calculated pot: %',
            v_game.pot,
            v_pot;
    END IF;


    ----------------------------------------------------------------
    -- 9. Count winning cards
    ----------------------------------------------------------------

    SELECT cardinality(p_winner_card_ids)
    INTO v_winner_count;


    IF v_winner_count <= 0 THEN
        RAISE EXCEPTION
            'Winning card count must be greater than zero';
    END IF;


    ----------------------------------------------------------------
    -- 10. Calculate equal payout per winning card
    --
    -- Work in cents to guarantee that:
    --
    -- SUM(all payouts) = exact pot
    --
    -- Example:
    --
    -- 100 / 3
    --
    -- Base = 33.33
    -- Remainder = 1 cent
    --
    -- First card gets 33.34
    -- Remaining cards get 33.33
    ----------------------------------------------------------------

    v_base_payout :=
        FLOOR(
            (v_pot * 100)
            / v_winner_count
        ) / 100;

    v_remainder_cents :=
        ROUND(v_pot * 100)
        -
        (
            ROUND(v_base_payout * 100)
            * v_winner_count
        );


    ----------------------------------------------------------------
    -- 11. Find Bingo game system
    ----------------------------------------------------------------

    SELECT id
    INTO v_game_system_id
    FROM game_systems
    WHERE code = 'bingo'
      AND status = 'active'
    LIMIT 1;

    IF v_game_system_id IS NULL THEN
        RAISE EXCEPTION
            'Active Bingo game system is not configured';
    END IF;


    ----------------------------------------------------------------
    -- 12. Settle every winning CARD
    ----------------------------------------------------------------

    FOR v_winner IN
        SELECT
            bp.id AS participant_id,
            bp.user_id,
            bp.card_id,

            (
                v_base_payout
                +
                CASE
                    WHEN ROW_NUMBER() OVER (
                        ORDER BY bp.card_id
                    ) <= v_remainder_cents
                    THEN 0.01
                    ELSE 0
                END
            )::numeric(18,2) AS payout

        FROM bingo_participants bp
        WHERE bp.game_id = p_game_id
          AND bp.card_id = ANY(p_winner_card_ids)

        ORDER BY bp.card_id
    LOOP

        ----------------------------------------------------------------
        -- 12a. Mark card as winner
        ----------------------------------------------------------------

        UPDATE bingo_participants
        SET
            is_winner = TRUE,
            amount_won = v_winner.payout
        WHERE id = v_winner.participant_id;


        ----------------------------------------------------------------
        -- 12b. Credit winner wallet
        --
        -- IMPORTANT:
        -- card_id is part of the idempotency key.
        ----------------------------------------------------------------

        PERFORM record_game_win(
            p_user_id         => v_winner.user_id,
            p_amount          => v_winner.payout,
            p_game_system_id  => v_game_system_id,
            p_source_type     => 'bingo_game',
            p_source_id       => p_game_id::text,
            p_idempotency_key =>
                'bingo:win:'
                || p_game_id
                || ':card:'
                || v_winner.card_id,
            p_description =>
                'Bingo game #'
                || p_game_id
                || ' card #'
                || v_winner.card_id
                || ' win',
            p_metadata =>
                jsonb_build_object(
                    'game_id',
                    p_game_id,
                    'card_id',
                    v_winner.card_id,
                    'participant_id',
                    v_winner.participant_id
                )
        );


        v_total_payout :=
            v_total_payout + v_winner.payout;

    END LOOP;


    ----------------------------------------------------------------
    -- 13. Safety check
    ----------------------------------------------------------------

    IF v_total_payout <> v_pot THEN
        RAISE EXCEPTION
            'Payout mismatch. Pot: %, total payout: %',
            v_pot,
            v_total_payout;
    END IF;


    ----------------------------------------------------------------
    -- 14. Update user statistics
    --
    -- A user can win multiple cards.
    ----------------------------------------------------------------

    UPDATE users u
    SET
        total_wins =
            COALESCE(u.total_wins, 0)
            + winner_stats.winning_cards,

        total_winnings =
            COALESCE(u.total_winnings, 0)
            + winner_stats.total_winnings

    FROM (
        SELECT
            bp.user_id,
            COUNT(*) AS winning_cards,
            SUM(bp.amount_won) AS total_winnings
        FROM bingo_participants bp
        WHERE bp.game_id = p_game_id
          AND bp.is_winner = TRUE
        GROUP BY bp.user_id
    ) AS winner_stats

    WHERE u.id = winner_stats.user_id;


    ----------------------------------------------------------------
    -- 15. Every participating USER gets one game played
    ----------------------------------------------------------------

    UPDATE users u
    SET total_games =
        COALESCE(u.total_games, 0) + 1
    WHERE u.id IN (
        SELECT DISTINCT user_id
        FROM bingo_participants
        WHERE game_id = p_game_id
    );


    ----------------------------------------------------------------
    -- 16. Get distinct winning USER IDs
    ----------------------------------------------------------------

    SELECT ARRAY_AGG(
        DISTINCT bp.user_id
        ORDER BY bp.user_id
    )
    INTO v_winner_user_ids
    FROM bingo_participants bp
    WHERE bp.game_id = p_game_id
      AND bp.is_winner = TRUE;


    ----------------------------------------------------------------
    -- 17. Complete the game
    ----------------------------------------------------------------

    UPDATE bingo_games
    SET
        status = 'completed',

        -- These are CARD IDs, not user IDs.
        winner_ids = p_winner_card_ids,

        win_amount = v_total_payout,

        -- Multiple winning cards = split
        is_split = v_winner_count > 1,

        ended_at = NOW()

    WHERE id = p_game_id;


    ----------------------------------------------------------------
    -- 18. Return complete settlement result
    ----------------------------------------------------------------

    RETURN jsonb_build_object(
        'game_id',
        p_game_id,

        'status',
        'completed',

        'pot',
        v_pot,

        'total_payout',
        v_total_payout,

        'winner_card_count',
        v_winner_count,

        'winner_card_ids',
        to_jsonb(p_winner_card_ids),

        'winner_user_ids',
        to_jsonb(v_winner_user_ids),

        'payout_per_card',
        CASE
            WHEN v_winner_count = 1
            THEN v_pot
            ELSE v_base_payout
        END
    );

END;
$$;


ALTER FUNCTION public.end_bingo_game(p_game_id integer, p_winner_card_ids integer[]) OWNER TO neondb_owner;

--
-- Name: generate_bingo_game_code(); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.generate_bingo_game_code() RETURNS character varying
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_code VARCHAR(32);
BEGIN
    LOOP
        v_code :=
            'BB' ||
            upper(
                substr(
                    md5(
                        random()::text ||
                        clock_timestamp()::text
                    ),
                    1,
                    6
                )
            );

        EXIT WHEN NOT EXISTS (
            SELECT 1
            FROM bingo_games
            WHERE game_code = v_code
        );
    END LOOP;

    RETURN v_code;
END;
$$;


ALTER FUNCTION public.generate_bingo_game_code() OWNER TO neondb_owner;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: deposit_rules; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.deposit_rules (
    id bigint NOT NULL,
    code character varying(100) NOT NULL,
    name character varying(150) NOT NULL,
    payment_method_id integer,
    payment_account_id integer,
    minimum_amount numeric(18,2),
    maximum_amount numeric(18,2),
    conditions jsonb DEFAULT '{}'::jsonb NOT NULL,
    starts_at timestamp with time zone,
    ends_at timestamp with time zone,
    is_active boolean DEFAULT true NOT NULL,
    created_by integer,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT deposit_rules_amount_range_check CHECK (((minimum_amount IS NULL) OR (maximum_amount IS NULL) OR (minimum_amount <= maximum_amount))),
    CONSTRAINT deposit_rules_date_range_check CHECK (((starts_at IS NULL) OR (ends_at IS NULL) OR (starts_at <= ends_at))),
    CONSTRAINT deposit_rules_positive_maximum_check CHECK (((maximum_amount IS NULL) OR (maximum_amount > (0)::numeric))),
    CONSTRAINT deposit_rules_positive_minimum_check CHECK (((minimum_amount IS NULL) OR (minimum_amount > (0)::numeric)))
);


ALTER TABLE public.deposit_rules OWNER TO neondb_owner;

--
-- Name: get_active_deposit_rule(integer, integer, numeric); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.get_active_deposit_rule(p_payment_method_id integer, p_payment_account_id integer, p_amount numeric) RETURNS public.deposit_rules
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_rule deposit_rules;
BEGIN

    SELECT dr.*
    INTO v_rule
    FROM deposit_rules dr
    WHERE dr.is_active = TRUE

      AND (
            dr.starts_at IS NULL
            OR dr.starts_at <= NOW()
          )

      AND (
            dr.ends_at IS NULL
            OR dr.ends_at >= NOW()
          )

      AND (
            dr.payment_method_id IS NULL
            OR dr.payment_method_id = p_payment_method_id
          )

      AND (
            dr.payment_account_id IS NULL
            OR dr.payment_account_id = p_payment_account_id
          )

      AND (
            dr.minimum_amount IS NULL
            OR p_amount >= dr.minimum_amount
          )

      AND (
            dr.maximum_amount IS NULL
            OR p_amount <= dr.maximum_amount
          )

    ORDER BY
        CASE
            WHEN dr.payment_account_id = p_payment_account_id
            THEN 0
            ELSE 1
        END,
        CASE
            WHEN dr.payment_method_id = p_payment_method_id
            THEN 0
            ELSE 1
        END,
        dr.id DESC

    LIMIT 1;


    RETURN v_rule;
END;
$$;


ALTER FUNCTION public.get_active_deposit_rule(p_payment_method_id integer, p_payment_account_id integer, p_amount numeric) OWNER TO neondb_owner;

--
-- Name: withdrawal_rules; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.withdrawal_rules (
    id bigint NOT NULL,
    code character varying(100) NOT NULL,
    name character varying(150) NOT NULL,
    payment_method_id integer,
    payment_account_id integer,
    minimum_amount numeric(18,2),
    maximum_amount numeric(18,2),
    conditions jsonb DEFAULT '{}'::jsonb NOT NULL,
    starts_at timestamp with time zone,
    ends_at timestamp with time zone,
    is_active boolean DEFAULT true NOT NULL,
    created_by integer,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT withdrawal_rules_amount_range_check CHECK (((minimum_amount IS NULL) OR (maximum_amount IS NULL) OR (minimum_amount <= maximum_amount))),
    CONSTRAINT withdrawal_rules_date_range_check CHECK (((starts_at IS NULL) OR (ends_at IS NULL) OR (starts_at <= ends_at))),
    CONSTRAINT withdrawal_rules_positive_maximum_check CHECK (((maximum_amount IS NULL) OR (maximum_amount > (0)::numeric))),
    CONSTRAINT withdrawal_rules_positive_minimum_check CHECK (((minimum_amount IS NULL) OR (minimum_amount > (0)::numeric)))
);


ALTER TABLE public.withdrawal_rules OWNER TO neondb_owner;

--
-- Name: get_active_withdrawal_rule(integer, integer, numeric); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.get_active_withdrawal_rule(p_payment_method_id integer, p_payment_account_id integer, p_amount numeric) RETURNS public.withdrawal_rules
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_rule withdrawal_rules;
BEGIN

    SELECT wr.*
    INTO v_rule
    FROM withdrawal_rules wr
    WHERE wr.is_active = TRUE

      AND (
            wr.starts_at IS NULL
            OR wr.starts_at <= NOW()
          )

      AND (
            wr.ends_at IS NULL
            OR wr.ends_at >= NOW()
          )

      AND (
            wr.payment_method_id IS NULL
            OR wr.payment_method_id = p_payment_method_id
          )

      AND (
            wr.payment_account_id IS NULL
            OR wr.payment_account_id = p_payment_account_id
          )

      AND (
            wr.minimum_amount IS NULL
            OR p_amount >= wr.minimum_amount
          )

      AND (
            wr.maximum_amount IS NULL
            OR p_amount <= wr.maximum_amount
          )

    ORDER BY
        CASE
            WHEN wr.payment_account_id = p_payment_account_id
            THEN 0
            ELSE 1
        END,
        CASE
            WHEN wr.payment_method_id = p_payment_method_id
            THEN 0
            ELSE 1
        END,
        wr.id DESC

    LIMIT 1;


    RETURN v_rule;
END;
$$;


ALTER FUNCTION public.get_active_withdrawal_rule(p_payment_method_id integer, p_payment_account_id integer, p_amount numeric) OWNER TO neondb_owner;

--
-- Name: get_user_wallet_id(integer, character varying); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.get_user_wallet_id(p_user_id integer, p_wallet_type character varying) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_wallet_id BIGINT;
BEGIN
    SELECT id
    INTO v_wallet_id
    FROM wallets
    WHERE user_id = p_user_id
      AND wallet_type = p_wallet_type
      AND is_active = TRUE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Active % wallet not found for user %',
            p_wallet_type,
            p_user_id;
    END IF;

    RETURN v_wallet_id;
END;
$$;


ALTER FUNCTION public.get_user_wallet_id(p_user_id integer, p_wallet_type character varying) OWNER TO neondb_owner;

--
-- Name: wallet_balances; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.wallet_balances (
    wallet_id bigint NOT NULL,
    balance numeric(18,2) DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT wallet_balances_non_negative CHECK ((balance >= (0)::numeric))
);


ALTER TABLE public.wallet_balances OWNER TO neondb_owner;

--
-- Name: lock_wallet(bigint); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.lock_wallet(p_wallet_id bigint) RETURNS public.wallet_balances
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_wallet wallet_balances;
BEGIN
    SELECT *
    INTO v_wallet
    FROM wallet_balances
    WHERE wallet_id = p_wallet_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Wallet balance not found: %',
            p_wallet_id;
    END IF;

    RETURN v_wallet;
END;
$$;


ALTER FUNCTION public.lock_wallet(p_wallet_id bigint) OWNER TO neondb_owner;

--
-- Name: place_stake(integer, numeric, bigint, character varying, character varying, character varying, text, jsonb); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.place_stake(p_user_id integer, p_amount numeric, p_game_system_id bigint, p_source_type character varying, p_source_id character varying, p_idempotency_key character varying, p_description text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_play_wallet_id BIGINT;
    v_main_wallet_id BIGINT;

    v_play_balance NUMERIC(18,2);
    v_main_balance NUMERIC(18,2);

    v_play_charge NUMERIC(18,2);
    v_main_charge NUMERIC(18,2);

    v_transaction_id BIGINT;

    v_existing_transaction financial_transactions%ROWTYPE;
BEGIN

    -- --------------------------------------------------------
    -- Validate amount
    -- --------------------------------------------------------

    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'Stake amount must be greater than zero';
    END IF;


    -- --------------------------------------------------------
    -- Check idempotency BEFORE changing anything
    -- --------------------------------------------------------

    IF p_idempotency_key IS NOT NULL THEN

        SELECT *
        INTO v_existing_transaction
        FROM financial_transactions
        WHERE idempotency_key = p_idempotency_key
        FOR UPDATE;

        IF FOUND THEN
            RETURN v_existing_transaction.id;
        END IF;

    END IF;


    -- --------------------------------------------------------
    -- Get wallets
    -- --------------------------------------------------------

    v_play_wallet_id :=
        get_user_wallet_id(p_user_id, 'play');

    v_main_wallet_id :=
        get_user_wallet_id(p_user_id, 'main');


    -- --------------------------------------------------------
    -- Lock wallets in deterministic order
    -- --------------------------------------------------------

    IF v_play_wallet_id < v_main_wallet_id THEN

        PERFORM lock_wallet(v_play_wallet_id);
        PERFORM lock_wallet(v_main_wallet_id);

    ELSE

        PERFORM lock_wallet(v_main_wallet_id);
        PERFORM lock_wallet(v_play_wallet_id);

    END IF;


    -- --------------------------------------------------------
    -- Read locked balances
    -- --------------------------------------------------------

    SELECT balance
    INTO v_play_balance
    FROM wallet_balances
    WHERE wallet_id = v_play_wallet_id;

    SELECT balance
    INTO v_main_balance
    FROM wallet_balances
    WHERE wallet_id = v_main_wallet_id;


    -- --------------------------------------------------------
    -- Check total available funds
    -- --------------------------------------------------------

    IF (v_play_balance + v_main_balance) < p_amount THEN

        RAISE EXCEPTION
            'Insufficient balance. Required: %, Available: %',
            p_amount,
            v_play_balance + v_main_balance;

    END IF;


    -- --------------------------------------------------------
    -- Calculate PLAY charge
    -- --------------------------------------------------------

    v_play_charge :=
        LEAST(v_play_balance, p_amount);


    -- --------------------------------------------------------
    -- Calculate MAIN charge
    -- --------------------------------------------------------

    v_main_charge :=
        p_amount - v_play_charge;


    -- --------------------------------------------------------
    -- Create transaction
    -- --------------------------------------------------------

    v_transaction_id :=
        create_financial_transaction(
            p_user_id,
            'stake',
            'completed',
            p_game_system_id,
            p_source_type,
            p_source_id,
            p_idempotency_key,
            p_description,
            p_metadata
        );


    -- --------------------------------------------------------
    -- PLAY ledger
    -- --------------------------------------------------------

    IF v_play_charge > 0 THEN

        INSERT INTO ledger_entries (
            transaction_id,
            wallet_id,
            amount
        )
        VALUES (
            v_transaction_id,
            v_play_wallet_id,
            -v_play_charge
        );


        UPDATE wallet_balances
        SET balance = balance - v_play_charge,
            updated_at = NOW()
        WHERE wallet_id = v_play_wallet_id;

    END IF;


    -- --------------------------------------------------------
    -- MAIN ledger
    -- --------------------------------------------------------

    IF v_main_charge > 0 THEN

        INSERT INTO ledger_entries (
            transaction_id,
            wallet_id,
            amount
        )
        VALUES (
            v_transaction_id,
            v_main_wallet_id,
            -v_main_charge
        );


        UPDATE wallet_balances
        SET balance = balance - v_main_charge,
            updated_at = NOW()
        WHERE wallet_id = v_main_wallet_id;

    END IF;


    RETURN v_transaction_id;

END;
$$;


ALTER FUNCTION public.place_stake(p_user_id integer, p_amount numeric, p_game_system_id bigint, p_source_type character varying, p_source_id character varying, p_idempotency_key character varying, p_description text, p_metadata jsonb) OWNER TO neondb_owner;

--
-- Name: record_game_win(integer, numeric, bigint, character varying, character varying, character varying, text, jsonb); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.record_game_win(p_user_id integer, p_amount numeric, p_game_system_id bigint, p_source_type character varying, p_source_id character varying, p_idempotency_key character varying, p_description text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_main_wallet_id BIGINT;
    v_transaction_id BIGINT;
    v_existing_transaction financial_transactions%ROWTYPE;
BEGIN

    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'Win amount must be greater than zero';
    END IF;


    -- --------------------------------------------------------
    -- Idempotency
    -- --------------------------------------------------------

    IF p_idempotency_key IS NOT NULL THEN

        SELECT *
        INTO v_existing_transaction
        FROM financial_transactions
        WHERE idempotency_key = p_idempotency_key
        FOR UPDATE;

        IF FOUND THEN
            RETURN v_existing_transaction.id;
        END IF;

    END IF;


    -- --------------------------------------------------------
    -- Main wallet
    -- --------------------------------------------------------

    v_main_wallet_id :=
        get_user_wallet_id(p_user_id, 'main');


    -- --------------------------------------------------------
    -- Lock Main
    -- --------------------------------------------------------

    PERFORM lock_wallet(v_main_wallet_id);


    -- --------------------------------------------------------
    -- Create transaction
    -- --------------------------------------------------------

    v_transaction_id :=
        create_financial_transaction(
            p_user_id,
            'win',
            'completed',
            p_game_system_id,
            p_source_type,
            p_source_id,
            p_idempotency_key,
            p_description,
            p_metadata
        );


    -- --------------------------------------------------------
    -- Ledger
    -- --------------------------------------------------------

    INSERT INTO ledger_entries (
        transaction_id,
        wallet_id,
        amount
    )
    VALUES (
        v_transaction_id,
        v_main_wallet_id,
        p_amount
    );


    -- --------------------------------------------------------
    -- Balance
    -- --------------------------------------------------------

    UPDATE wallet_balances
    SET balance = balance + p_amount,
        updated_at = NOW()
    WHERE wallet_id = v_main_wallet_id;


    RETURN v_transaction_id;

END;
$$;


ALTER FUNCTION public.record_game_win(p_user_id integer, p_amount numeric, p_game_system_id bigint, p_source_type character varying, p_source_id character varying, p_idempotency_key character varying, p_description text, p_metadata jsonb) OWNER TO neondb_owner;

--
-- Name: refund_stake(integer, bigint, character varying, text, jsonb); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.refund_stake(p_user_id integer, p_original_transaction_id bigint, p_idempotency_key character varying, p_description text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_original financial_transactions%ROWTYPE;
    v_refund_transaction_id BIGINT;
    v_wallet_id BIGINT;
    v_refund_amount NUMERIC(18,2);
    v_wallet_ids BIGINT[];
BEGIN

    -- --------------------------------------------------------
    -- Validate original transaction
    -- --------------------------------------------------------

    SELECT *
    INTO v_original
    FROM financial_transactions
    WHERE id = p_original_transaction_id
      AND user_id = p_user_id
      AND type = 'stake'
      AND status = 'completed';

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Original stake transaction not found: %',
            p_original_transaction_id;
    END IF;


    -- --------------------------------------------------------
    -- Idempotency
    -- --------------------------------------------------------

    IF p_idempotency_key IS NOT NULL THEN

        SELECT id
        INTO v_refund_transaction_id
        FROM financial_transactions
        WHERE idempotency_key = p_idempotency_key;

        IF FOUND THEN
            RETURN v_refund_transaction_id;
        END IF;

    END IF;


    -- --------------------------------------------------------
    -- Lock every wallet involved in original transaction.
    --
    -- First retrieve wallet IDs and sort them so all callers
    -- lock them in the same order.
    -- --------------------------------------------------------

    SELECT ARRAY_AGG(wallet_id ORDER BY wallet_id)
    INTO v_wallet_ids
    FROM ledger_entries
    WHERE transaction_id = p_original_transaction_id
      AND amount < 0;


    IF v_wallet_ids IS NULL
       OR array_length(v_wallet_ids, 1) IS NULL THEN

        RAISE EXCEPTION
            'Original stake has no debit ledger entries';

    END IF;


    FOREACH v_wallet_id IN ARRAY v_wallet_ids
    LOOP
        PERFORM lock_wallet(v_wallet_id);
    END LOOP;


    -- --------------------------------------------------------
    -- Create refund transaction
    -- --------------------------------------------------------

    v_refund_transaction_id :=
        create_financial_transaction(
            p_user_id,
            'refund',
            'completed',
            v_original.game_system_id,
            'stake_refund',
            p_original_transaction_id::TEXT,
            p_idempotency_key,
            p_description,
            COALESCE(p_metadata, '{}'::jsonb)
            ||
            jsonb_build_object(
                'original_transaction_id',
                p_original_transaction_id
            )
        );


    -- --------------------------------------------------------
    -- Reverse each original debit.
    -- --------------------------------------------------------

    FOR v_wallet_id, v_refund_amount IN
        SELECT
            wallet_id,
            ABS(amount)
        FROM ledger_entries
        WHERE transaction_id = p_original_transaction_id
          AND amount < 0
        ORDER BY wallet_id
    LOOP

        INSERT INTO ledger_entries (
            transaction_id,
            wallet_id,
            amount
        )
        VALUES (
            v_refund_transaction_id,
            v_wallet_id,
            v_refund_amount
        );


        UPDATE wallet_balances
        SET balance = balance + v_refund_amount,
            updated_at = NOW()
        WHERE wallet_id = v_wallet_id;

    END LOOP;


    RETURN v_refund_transaction_id;

END;
$$;


ALTER FUNCTION public.refund_stake(p_user_id integer, p_original_transaction_id bigint, p_idempotency_key character varying, p_description text, p_metadata jsonb) OWNER TO neondb_owner;

--
-- Name: refund_withdrawal(integer, bigint, bigint, character varying, text); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.refund_withdrawal(p_user_id integer, p_withdrawal_id bigint, p_original_transaction_id bigint, p_idempotency_key character varying DEFAULT NULL::character varying, p_description text DEFAULT NULL::text) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_wallet_id BIGINT;
    v_transaction_id BIGINT;
    v_existing_transaction BIGINT;
    v_amount NUMERIC(18,2);
BEGIN

    -- Idempotency
    IF p_idempotency_key IS NOT NULL THEN

        SELECT id
        INTO v_existing_transaction
        FROM financial_transactions
        WHERE idempotency_key = p_idempotency_key
        LIMIT 1;

        IF v_existing_transaction IS NOT NULL THEN
            RETURN v_existing_transaction;
        END IF;

    END IF;


    SELECT ABS(SUM(le.amount))
    INTO v_amount
    FROM ledger_entries le
    WHERE le.transaction_id = p_original_transaction_id
      AND le.amount < 0;


    IF v_amount IS NULL OR v_amount <= 0 THEN
        RAISE EXCEPTION
            'Original withdrawal transaction has no valid debit';
    END IF;


    v_wallet_id :=
        get_user_wallet_id(
            p_user_id,
            'main'
        );


    PERFORM lock_wallet(v_wallet_id);


    v_transaction_id :=
        create_financial_transaction(
            p_user_id,
            'refund',
            'completed',
            NULL,
            'withdrawal_refund',
            p_withdrawal_id::VARCHAR,
            p_idempotency_key,
            p_description,
            jsonb_build_object(
                'withdrawal_id',
                p_withdrawal_id,
                'original_transaction_id',
                p_original_transaction_id
            )
        );


    INSERT INTO ledger_entries (
        transaction_id,
        wallet_id,
        amount
    )
    VALUES (
        v_transaction_id,
        v_wallet_id,
        v_amount
    );


    UPDATE wallet_balances
    SET balance = balance + v_amount,
        updated_at = NOW()
    WHERE wallet_id = v_wallet_id;


    RETURN v_transaction_id;
END;
$$;


ALTER FUNCTION public.refund_withdrawal(p_user_id integer, p_withdrawal_id bigint, p_original_transaction_id bigint, p_idempotency_key character varying, p_description text) OWNER TO neondb_owner;

--
-- Name: users; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.users (
    id integer NOT NULL,
    telegram_id bigint NOT NULL,
    name character varying(50) NOT NULL,
    phone character varying(20),
    balance numeric(18,2),
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
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT users_admin_role_check CHECK (((admin_role IS NULL) OR ((admin_role)::text = ANY ((ARRAY['main'::character varying, 'statistics'::character varying, 'withdrawal'::character varying, 'broadcast'::character varying])::text[]))))
);


ALTER TABLE public.users OWNER TO neondb_owner;

--
-- Name: register_user(bigint, character varying, character varying); Type: FUNCTION; Schema: public; Owner: neondb_owner
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


ALTER FUNCTION public.register_user(p_telegram_id bigint, p_name character varying, p_phone character varying) OWNER TO neondb_owner;

--
-- Name: remove_bingo_participant(integer, integer, integer); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.remove_bingo_participant(p_game_id integer, p_user_id integer, p_card_id integer) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_game bingo_games%ROWTYPE;
    v_participant bingo_participants%ROWTYPE;

    v_stake numeric(18,2);
    v_refund_transaction_id bigint;
    v_new_pot numeric(18,2);
    v_calculated_pot numeric(18,2);
BEGIN

    ----------------------------------------------------------------
    -- 1. Validate input
    ----------------------------------------------------------------

    IF p_game_id IS NULL OR p_game_id <= 0 THEN
        RAISE EXCEPTION 'Invalid Bingo game ID';
    END IF;

    IF p_user_id IS NULL OR p_user_id <= 0 THEN
        RAISE EXCEPTION 'Invalid user ID';
    END IF;

    IF p_card_id IS NULL OR p_card_id <= 0 THEN
        RAISE EXCEPTION 'Invalid card ID';
    END IF;


    ----------------------------------------------------------------
    -- 2. Lock the Bingo game
    --
    -- This prevents two requests from changing the pot
    -- simultaneously.
    ----------------------------------------------------------------

    SELECT *
    INTO v_game
    FROM bingo_games
    WHERE id = p_game_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Bingo game % not found',
            p_game_id;
    END IF;


    ----------------------------------------------------------------
    -- 3. Card can only be removed while the game is active
    ----------------------------------------------------------------

    IF v_game.status NOT IN ('waiting', 'playing') THEN
        RAISE EXCEPTION
            'Bingo game % is no longer accepting card changes',
            p_game_id;
    END IF;


    ----------------------------------------------------------------
    -- 4. Find the EXACT user's card
    --
    -- A user may have multiple cards.
    -- We must only remove the requested card.
    ----------------------------------------------------------------

    SELECT *
    INTO v_participant
    FROM bingo_participants
    WHERE game_id = p_game_id
      AND user_id = p_user_id
      AND card_id = p_card_id
      AND status = 'active'
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'User % has not selected card % in Bingo game %',
            p_user_id,
            p_card_id,
            p_game_id;
    END IF;


    ----------------------------------------------------------------
    -- 5. Never allow a winning card to be removed
    ----------------------------------------------------------------

    IF v_participant.is_winner = TRUE THEN
        RAISE EXCEPTION
            'Winning card % cannot be removed',
            p_card_id;
    END IF;


    ----------------------------------------------------------------
    -- 6. Use the ACTUAL amount charged for this card
    --
    -- Do not use bingo_games.stake_amount here.
    -- The participant amount is the amount actually charged.
    ----------------------------------------------------------------

    v_stake := ROUND(v_participant.amount, 2);

    IF v_stake <= 0 THEN
        RAISE EXCEPTION
            'Invalid stake amount for participant %',
            v_participant.id;
    END IF;


    ----------------------------------------------------------------
    -- 7. Validate current pot before changing it
    ----------------------------------------------------------------

    IF ROUND(v_game.pot, 2) < v_stake THEN
        RAISE EXCEPTION
            'Invalid Bingo pot. Pot: %, participant stake: %',
            v_game.pot,
            v_stake;
    END IF;


    ----------------------------------------------------------------
    -- 8. Refund the original stake
    --
    -- refund_stake():
    --   - validates the original stake transaction
    --   - reverses the ledger debit
    --   - credits the wallet
    --   - creates a refund transaction
    --
    -- Everything remains inside this database transaction.
    ----------------------------------------------------------------

    v_refund_transaction_id :=
        refund_stake(
            p_user_id,
            v_participant.transaction_id,
            format(
                'bingo:card-remove:%s:%s:%s',
                p_game_id,
                p_user_id,
                p_card_id
            ),
            format(
                'Bingo card %s deselected from game %s',
                p_card_id,
                p_game_id
            ),
            jsonb_build_object(
                'game_id', p_game_id,
                'user_id', p_user_id,
                'card_id', p_card_id,
                'participant_id', v_participant.id,
                'original_transaction_id',
                    v_participant.transaction_id,
                'reason', 'card_deselected'
            )
        );


    ----------------------------------------------------------------
    -- 9. Remove the participant/card
    ----------------------------------------------------------------

    DELETE FROM bingo_participants
    WHERE id = v_participant.id;


    ----------------------------------------------------------------
    -- 10. Decrease the Bingo pot
    ----------------------------------------------------------------

    UPDATE bingo_games
    SET pot = ROUND(pot - v_stake, 2)
    WHERE id = p_game_id
    RETURNING pot
    INTO v_new_pot;


    IF v_new_pot IS NULL THEN
        RAISE EXCEPTION
            'Failed to update Bingo game pot';
    END IF;


    ----------------------------------------------------------------
    -- 11. Final consistency check
    --
    -- The pot must equal the total amount of all remaining
    -- active Bingo cards.
    ----------------------------------------------------------------

    SELECT ROUND(
        COALESCE(SUM(amount), 0),
        2
    )
    INTO v_calculated_pot
    FROM bingo_participants
    WHERE game_id = p_game_id
      AND status = 'active';


    IF v_new_pot <> v_calculated_pot THEN
        RAISE EXCEPTION
            'Bingo pot mismatch after card removal. Game pot: %, calculated pot: %',
            v_new_pot,
            v_calculated_pot;
    END IF;


    ----------------------------------------------------------------
    -- 12. Return result
    ----------------------------------------------------------------

    RETURN jsonb_build_object(
        'success', TRUE,
        'game_id', p_game_id,
        'user_id', p_user_id,
        'card_id', p_card_id,
        'participant_id', v_participant.id,
        'refunded_amount', v_stake,
        'refund_transaction_id', v_refund_transaction_id,
        'new_pot', v_new_pot
    );

END;
$$;


ALTER FUNCTION public.remove_bingo_participant(p_game_id integer, p_user_id integer, p_card_id integer) OWNER TO neondb_owner;

--
-- Name: reserve_withdrawal_from_main(integer, numeric, bigint, character varying, text); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.reserve_withdrawal_from_main(p_user_id integer, p_amount numeric, p_withdrawal_id bigint, p_idempotency_key character varying DEFAULT NULL::character varying, p_description text DEFAULT NULL::text) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_wallet_id BIGINT;
    v_transaction_id BIGINT;
    v_existing_transaction BIGINT;
    v_balance NUMERIC(18,2);
    v_amount NUMERIC(18,2);
BEGIN

    v_amount := ROUND(p_amount, 2);

    IF v_amount <= 0 THEN
        RAISE EXCEPTION 'Withdrawal amount must be greater than zero';
    END IF;


    -- Idempotency
    IF p_idempotency_key IS NOT NULL THEN

        SELECT id
        INTO v_existing_transaction
        FROM financial_transactions
        WHERE idempotency_key = p_idempotency_key
        LIMIT 1;

        IF v_existing_transaction IS NOT NULL THEN
            RETURN v_existing_transaction;
        END IF;

    END IF;


    v_wallet_id :=
        get_user_wallet_id(
            p_user_id,
            'main'
        );


    -- Lock Main wallet
    PERFORM lock_wallet(v_wallet_id);


    SELECT balance
    INTO v_balance
    FROM wallet_balances
    WHERE wallet_id = v_wallet_id;


    IF v_balance < v_amount THEN
        RAISE EXCEPTION
            'Insufficient Main wallet balance. Available: %, requested: %',
            v_balance,
            v_amount;
    END IF;


    v_transaction_id :=
        create_financial_transaction(
            p_user_id,
            'withdrawal',
            'completed',
            NULL,
            'withdrawal',
            p_withdrawal_id::VARCHAR,
            p_idempotency_key,
            p_description,
            jsonb_build_object(
                'withdrawal_id',
                p_withdrawal_id
            )
        );


    INSERT INTO ledger_entries (
        transaction_id,
        wallet_id,
        amount
    )
    VALUES (
        v_transaction_id,
        v_wallet_id,
        -v_amount
    );


    UPDATE wallet_balances
    SET balance = balance - v_amount,
        updated_at = NOW()
    WHERE wallet_id = v_wallet_id;


    RETURN v_transaction_id;
END;
$$;


ALTER FUNCTION public.reserve_withdrawal_from_main(p_user_id integer, p_amount numeric, p_withdrawal_id bigint, p_idempotency_key character varying, p_description text) OWNER TO neondb_owner;

--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.set_updated_at() OWNER TO neondb_owner;

--
-- Name: validate_deposit_rule(bigint, integer, integer, numeric); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.validate_deposit_rule(p_rule_id bigint, p_payment_method_id integer, p_payment_account_id integer, p_amount numeric) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_rule deposit_rules;
BEGIN

    SELECT *
    INTO v_rule
    FROM deposit_rules
    WHERE id = p_rule_id
      AND is_active = TRUE;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;


    IF v_rule.starts_at IS NOT NULL
       AND NOW() < v_rule.starts_at THEN
        RETURN FALSE;
    END IF;


    IF v_rule.ends_at IS NOT NULL
       AND NOW() > v_rule.ends_at THEN
        RETURN FALSE;
    END IF;


    IF v_rule.payment_method_id IS NOT NULL
       AND v_rule.payment_method_id <> p_payment_method_id THEN
        RETURN FALSE;
    END IF;


    IF v_rule.payment_account_id IS NOT NULL
       AND v_rule.payment_account_id <> p_payment_account_id THEN
        RETURN FALSE;
    END IF;


    IF v_rule.minimum_amount IS NOT NULL
       AND p_amount < v_rule.minimum_amount THEN
        RETURN FALSE;
    END IF;


    IF v_rule.maximum_amount IS NOT NULL
       AND p_amount > v_rule.maximum_amount THEN
        RETURN FALSE;
    END IF;


    RETURN TRUE;
END;
$$;


ALTER FUNCTION public.validate_deposit_rule(p_rule_id bigint, p_payment_method_id integer, p_payment_account_id integer, p_amount numeric) OWNER TO neondb_owner;

--
-- Name: validate_withdrawal_rule(bigint, integer, integer, numeric); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.validate_withdrawal_rule(p_rule_id bigint, p_payment_method_id integer, p_payment_account_id integer, p_amount numeric) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_rule withdrawal_rules;
BEGIN

    SELECT *
    INTO v_rule
    FROM withdrawal_rules
    WHERE id = p_rule_id
      AND is_active = TRUE;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;


    IF v_rule.starts_at IS NOT NULL
       AND NOW() < v_rule.starts_at THEN
        RETURN FALSE;
    END IF;


    IF v_rule.ends_at IS NOT NULL
       AND NOW() > v_rule.ends_at THEN
        RETURN FALSE;
    END IF;


    IF v_rule.payment_method_id IS NOT NULL
       AND v_rule.payment_method_id <> p_payment_method_id THEN
        RETURN FALSE;
    END IF;


    IF v_rule.payment_account_id IS NOT NULL
       AND v_rule.payment_account_id <> p_payment_account_id THEN
        RETURN FALSE;
    END IF;


    IF v_rule.minimum_amount IS NOT NULL
       AND p_amount < v_rule.minimum_amount THEN
        RETURN FALSE;
    END IF;


    IF v_rule.maximum_amount IS NOT NULL
       AND p_amount > v_rule.maximum_amount THEN
        RETURN FALSE;
    END IF;


    RETURN TRUE;
END;
$$;


ALTER FUNCTION public.validate_withdrawal_rule(p_rule_id bigint, p_payment_method_id integer, p_payment_account_id integer, p_amount numeric) OWNER TO neondb_owner;

--
-- Name: bingo_games; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.bingo_games (
    id integer CONSTRAINT games_id_not_null NOT NULL,
    room_id uuid CONSTRAINT games_room_id_not_null NOT NULL,
    stake_id character varying(10) CONSTRAINT games_stake_id_not_null NOT NULL,
    stake_amount numeric(18,2) CONSTRAINT games_stake_amount_not_null NOT NULL,
    pot numeric(18,2) CONSTRAINT games_pot_not_null NOT NULL,
    status character varying(20) DEFAULT 'waiting'::character varying,
    called_numbers integer[] DEFAULT '{}'::integer[],
    winner_card_ids integer[] DEFAULT '{}'::integer[],
    win_amount numeric(18,2) DEFAULT 0,
    is_split boolean DEFAULT false,
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    game_code character varying(32) NOT NULL
);


ALTER TABLE public.bingo_games OWNER TO neondb_owner;

--
-- Name: bingo_games_id_seq; Type: SEQUENCE; Schema: public; Owner: neondb_owner
--

CREATE SEQUENCE public.bingo_games_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.bingo_games_id_seq OWNER TO neondb_owner;

--
-- Name: bingo_games_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: neondb_owner
--

ALTER SEQUENCE public.bingo_games_id_seq OWNED BY public.bingo_games.id;


--
-- Name: bingo_participants; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.bingo_participants (
    id bigint NOT NULL,
    game_id integer NOT NULL,
    user_id integer NOT NULL,
    card_id integer NOT NULL,
    card_data jsonb NOT NULL,
    transaction_id bigint NOT NULL,
    amount numeric(18,2) NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    is_winner boolean DEFAULT false NOT NULL,
    is_disqualified boolean DEFAULT false NOT NULL,
    amount_won numeric(18,2) DEFAULT 0 NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bingo_participants_amount_positive CHECK ((amount > (0)::numeric)),
    CONSTRAINT bingo_participants_amount_won_non_negative CHECK ((amount_won >= (0)::numeric)),
    CONSTRAINT bingo_participants_card_id_positive CHECK ((card_id > 0)),
    CONSTRAINT bingo_participants_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'refunded'::character varying, 'cancelled'::character varying])::text[])))
);


ALTER TABLE public.bingo_participants OWNER TO neondb_owner;

--
-- Name: bingo_participants_id_seq; Type: SEQUENCE; Schema: public; Owner: neondb_owner
--

CREATE SEQUENCE public.bingo_participants_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.bingo_participants_id_seq OWNER TO neondb_owner;

--
-- Name: bingo_participants_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: neondb_owner
--

ALTER SEQUENCE public.bingo_participants_id_seq OWNED BY public.bingo_participants.id;


--
-- Name: bingo_winners; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.bingo_winners (
    id bigint NOT NULL,
    game_id integer NOT NULL,
    participant_id bigint NOT NULL,
    user_id integer NOT NULL,
    card_id integer NOT NULL,
    payout numeric(18,2) NOT NULL,
    transaction_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bingo_winners_payout_check CHECK ((payout > (0)::numeric))
);


ALTER TABLE public.bingo_winners OWNER TO neondb_owner;

--
-- Name: bingo_winners_id_seq; Type: SEQUENCE; Schema: public; Owner: neondb_owner
--

CREATE SEQUENCE public.bingo_winners_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.bingo_winners_id_seq OWNER TO neondb_owner;

--
-- Name: bingo_winners_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: neondb_owner
--

ALTER SEQUENCE public.bingo_winners_id_seq OWNED BY public.bingo_winners.id;


--
-- Name: broadcast_drafts; Type: TABLE; Schema: public; Owner: neondb_owner
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


ALTER TABLE public.broadcast_drafts OWNER TO neondb_owner;

--
-- Name: payment_accounts; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.payment_accounts (
    id integer CONSTRAINT deposit_accounts_id_not_null NOT NULL,
    payment_method_id integer CONSTRAINT deposit_accounts_payment_method_id_not_null NOT NULL,
    account_name character varying(100),
    account_number character varying(100),
    balance numeric(18,2) DEFAULT 0.00 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    is_removed boolean DEFAULT false CONSTRAINT payment_accounts_permanently_removed_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.payment_accounts OWNER TO neondb_owner;

--
-- Name: deposit_accounts_id_seq; Type: SEQUENCE; Schema: public; Owner: neondb_owner
--

CREATE SEQUENCE public.deposit_accounts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.deposit_accounts_id_seq OWNER TO neondb_owner;

--
-- Name: deposit_accounts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: neondb_owner
--

ALTER SEQUENCE public.deposit_accounts_id_seq OWNED BY public.payment_accounts.id;


--
-- Name: deposits; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.deposits (
    id integer CONSTRAINT deposit_id_not_null NOT NULL,
    user_id integer CONSTRAINT deposit_user_id_not_null NOT NULL,
    payment_account_id integer CONSTRAINT deposit_payment_account_id_not_null NOT NULL,
    deposit_method_id integer CONSTRAINT deposit_deposit_method_id_not_null NOT NULL,
    depositor_name character varying(100),
    depositor_account character varying(20),
    amount numeric(18,2),
    reference character varying(100),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    transaction_id bigint,
    rule_id bigint,
    status character varying(20) DEFAULT 'completed'::character varying,
    approved_by_id integer,
    approved_at timestamp with time zone,
    rejected_by_id integer,
    rejected_at timestamp with time zone,
    rejection_reason character varying(150),
    CONSTRAINT deposits_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'processing'::character varying, 'completed'::character varying, 'rejected'::character varying, 'cancelled'::character varying, 'failed'::character varying, 'reversed'::character varying])::text[])))
);


ALTER TABLE public.deposits OWNER TO neondb_owner;

--
-- Name: deposit_id_seq; Type: SEQUENCE; Schema: public; Owner: neondb_owner
--

CREATE SEQUENCE public.deposit_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.deposit_id_seq OWNER TO neondb_owner;

--
-- Name: deposit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: neondb_owner
--

ALTER SEQUENCE public.deposit_id_seq OWNED BY public.deposits.id;


--
-- Name: deposit_rules_id_seq; Type: SEQUENCE; Schema: public; Owner: neondb_owner
--

CREATE SEQUENCE public.deposit_rules_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.deposit_rules_id_seq OWNER TO neondb_owner;

--
-- Name: deposit_rules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: neondb_owner
--

ALTER SEQUENCE public.deposit_rules_id_seq OWNED BY public.deposit_rules.id;


--
-- Name: financial_transactions; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.financial_transactions (
    id bigint NOT NULL,
    user_id integer,
    type character varying(30) NOT NULL,
    status character varying(20) DEFAULT 'completed'::character varying NOT NULL,
    game_system_id bigint,
    source_type character varying(50),
    source_id character varying(100),
    idempotency_key character varying(150),
    description text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    reversed_transaction_id bigint,
    CONSTRAINT financial_transactions_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'processing'::character varying, 'completed'::character varying, 'failed'::character varying, 'cancelled'::character varying, 'reversed'::character varying])::text[]))),
    CONSTRAINT financial_transactions_type_check CHECK (((type)::text = ANY ((ARRAY['deposit'::character varying, 'withdrawal'::character varying, 'stake'::character varying, 'win'::character varying, 'refund'::character varying, 'transfer'::character varying, 'bonus'::character varying, 'referral'::character varying, 'cashback'::character varying, 'adjustment'::character varying, 'reversal'::character varying])::text[])))
);


ALTER TABLE public.financial_transactions OWNER TO neondb_owner;

--
-- Name: financial_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: neondb_owner
--

CREATE SEQUENCE public.financial_transactions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.financial_transactions_id_seq OWNER TO neondb_owner;

--
-- Name: financial_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: neondb_owner
--

ALTER SEQUENCE public.financial_transactions_id_seq OWNED BY public.financial_transactions.id;


--
-- Name: game_systems; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.game_systems (
    id bigint NOT NULL,
    code character varying(50) NOT NULL,
    name character varying(100) NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT game_systems_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'inactive'::character varying, 'maintenance'::character varying, 'disabled'::character varying])::text[])))
);


ALTER TABLE public.game_systems OWNER TO neondb_owner;

--
-- Name: game_systems_id_seq; Type: SEQUENCE; Schema: public; Owner: neondb_owner
--

CREATE SEQUENCE public.game_systems_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.game_systems_id_seq OWNER TO neondb_owner;

--
-- Name: game_systems_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: neondb_owner
--

ALTER SEQUENCE public.game_systems_id_seq OWNED BY public.game_systems.id;


--
-- Name: games_id_seq; Type: SEQUENCE; Schema: public; Owner: neondb_owner
--

CREATE SEQUENCE public.games_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.games_id_seq OWNER TO neondb_owner;

--
-- Name: games_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: neondb_owner
--

ALTER SEQUENCE public.games_id_seq OWNED BY public.bingo_games.id;


--
-- Name: leaderboard; Type: VIEW; Schema: public; Owner: neondb_owner
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


ALTER VIEW public.leaderboard OWNER TO neondb_owner;

--
-- Name: ledger_entries; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.ledger_entries (
    id bigint NOT NULL,
    transaction_id bigint NOT NULL,
    wallet_id bigint NOT NULL,
    amount numeric(18,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ledger_entries_amount_non_zero CHECK ((amount <> (0)::numeric))
);


ALTER TABLE public.ledger_entries OWNER TO neondb_owner;

--
-- Name: ledger_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: neondb_owner
--

CREATE SEQUENCE public.ledger_entries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.ledger_entries_id_seq OWNER TO neondb_owner;

--
-- Name: ledger_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: neondb_owner
--

ALTER SEQUENCE public.ledger_entries_id_seq OWNED BY public.ledger_entries.id;


--
-- Name: payment_methods; Type: TABLE; Schema: public; Owner: neondb_owner
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


ALTER TABLE public.payment_methods OWNER TO neondb_owner;

--
-- Name: payment_methods_id_seq; Type: SEQUENCE; Schema: public; Owner: neondb_owner
--

CREATE SEQUENCE public.payment_methods_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.payment_methods_id_seq OWNER TO neondb_owner;

--
-- Name: payment_methods_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: neondb_owner
--

ALTER SEQUENCE public.payment_methods_id_seq OWNED BY public.payment_methods.id;


--
-- Name: payment_types; Type: TABLE; Schema: public; Owner: neondb_owner
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


ALTER TABLE public.payment_types OWNER TO neondb_owner;

--
-- Name: payment_type_id_seq; Type: SEQUENCE; Schema: public; Owner: neondb_owner
--

CREATE SEQUENCE public.payment_type_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.payment_type_id_seq OWNER TO neondb_owner;

--
-- Name: payment_type_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: neondb_owner
--

ALTER SEQUENCE public.payment_type_id_seq OWNED BY public.payment_types.id;


--
-- Name: settings; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.settings (
    key text NOT NULL,
    value text
);


ALTER TABLE public.settings OWNER TO neondb_owner;

--
-- Name: transaction_ledger_totals; Type: VIEW; Schema: public; Owner: neondb_owner
--

CREATE VIEW public.transaction_ledger_totals AS
 SELECT ft.id AS transaction_id,
    ft.type,
    ft.status,
    ft.user_id,
    ft.game_system_id,
    COALESCE(sum(le.amount), (0)::numeric) AS ledger_total,
    count(le.id) AS ledger_entry_count,
    ft.created_at
   FROM (public.financial_transactions ft
     LEFT JOIN public.ledger_entries le ON ((le.transaction_id = ft.id)))
  GROUP BY ft.id, ft.type, ft.status, ft.user_id, ft.game_system_id, ft.created_at;


ALTER VIEW public.transaction_ledger_totals OWNER TO neondb_owner;

--
-- Name: transfers; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.transfers (
    id bigint NOT NULL,
    transaction_id bigint NOT NULL,
    sender_user_id integer NOT NULL,
    receiver_user_id integer NOT NULL,
    amount numeric(18,2) NOT NULL,
    status character varying(20) DEFAULT 'completed'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT transfers_different_users CHECK ((sender_user_id <> receiver_user_id)),
    CONSTRAINT transfers_positive_amount CHECK ((amount > (0)::numeric)),
    CONSTRAINT transfers_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'completed'::character varying, 'failed'::character varying, 'cancelled'::character varying, 'reversed'::character varying])::text[])))
);


ALTER TABLE public.transfers OWNER TO neondb_owner;

--
-- Name: transfers_id_seq; Type: SEQUENCE; Schema: public; Owner: neondb_owner
--

CREATE SEQUENCE public.transfers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.transfers_id_seq OWNER TO neondb_owner;

--
-- Name: transfers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: neondb_owner
--

ALTER SEQUENCE public.transfers_id_seq OWNED BY public.transfers.id;


--
-- Name: wallets; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.wallets (
    id bigint NOT NULL,
    user_id integer NOT NULL,
    wallet_type character varying(20) NOT NULL,
    currency character(3) DEFAULT 'ETB'::bpchar NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT wallets_type_check CHECK (((wallet_type)::text = ANY ((ARRAY['main'::character varying, 'play'::character varying])::text[])))
);


ALTER TABLE public.wallets OWNER TO neondb_owner;

--
-- Name: user_wallet_balances; Type: VIEW; Schema: public; Owner: neondb_owner
--

CREATE VIEW public.user_wallet_balances AS
 SELECT u.id AS user_id,
    u.telegram_id,
    u.name,
    main.wallet_id AS main_wallet_id,
    main.balance AS main_balance,
    play.wallet_id AS play_wallet_id,
    play.balance AS play_balance,
    (COALESCE(main.balance, (0)::numeric) + COALESCE(play.balance, (0)::numeric)) AS total_balance
   FROM ((public.users u
     LEFT JOIN ( SELECT w.user_id,
            w.id AS wallet_id,
            wb.balance
           FROM (public.wallets w
             JOIN public.wallet_balances wb ON ((wb.wallet_id = w.id)))
          WHERE ((w.wallet_type)::text = 'main'::text)) main ON ((main.user_id = u.id)))
     LEFT JOIN ( SELECT w.user_id,
            w.id AS wallet_id,
            wb.balance
           FROM (public.wallets w
             JOIN public.wallet_balances wb ON ((wb.wallet_id = w.id)))
          WHERE ((w.wallet_type)::text = 'play'::text)) play ON ((play.user_id = u.id)));


ALTER VIEW public.user_wallet_balances OWNER TO neondb_owner;

--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: neondb_owner
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.users_id_seq OWNER TO neondb_owner;

--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: neondb_owner
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: wallet_migration_check; Type: VIEW; Schema: public; Owner: neondb_owner
--

CREATE VIEW public.wallet_migration_check AS
 SELECT u.id AS user_id,
    u.telegram_id,
    COALESCE(max(
        CASE
            WHEN ((w.wallet_type)::text = 'main'::text) THEN wb.balance
            ELSE NULL::numeric
        END), (0)::numeric) AS main_balance,
    COALESCE(max(
        CASE
            WHEN ((w.wallet_type)::text = 'play'::text) THEN wb.balance
            ELSE NULL::numeric
        END), (0)::numeric) AS play_balance,
    (COALESCE(max(
        CASE
            WHEN ((w.wallet_type)::text = 'main'::text) THEN wb.balance
            ELSE NULL::numeric
        END), (0)::numeric) + COALESCE(max(
        CASE
            WHEN ((w.wallet_type)::text = 'play'::text) THEN wb.balance
            ELSE NULL::numeric
        END), (0)::numeric)) AS new_total_balance,
    u.balance AS legacy_balance,
    ((COALESCE(max(
        CASE
            WHEN ((w.wallet_type)::text = 'main'::text) THEN wb.balance
            ELSE NULL::numeric
        END), (0)::numeric) + COALESCE(max(
        CASE
            WHEN ((w.wallet_type)::text = 'play'::text) THEN wb.balance
            ELSE NULL::numeric
        END), (0)::numeric)) - COALESCE(u.balance, (0)::numeric)) AS difference
   FROM ((public.users u
     LEFT JOIN public.wallets w ON ((w.user_id = u.id)))
     LEFT JOIN public.wallet_balances wb ON ((wb.wallet_id = w.id)))
  GROUP BY u.id, u.telegram_id, u.balance;


ALTER VIEW public.wallet_migration_check OWNER TO neondb_owner;

--
-- Name: wallets_id_seq; Type: SEQUENCE; Schema: public; Owner: neondb_owner
--

CREATE SEQUENCE public.wallets_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.wallets_id_seq OWNER TO neondb_owner;

--
-- Name: wallets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: neondb_owner
--

ALTER SEQUENCE public.wallets_id_seq OWNED BY public.wallets.id;


--
-- Name: withdrawal_rules_id_seq; Type: SEQUENCE; Schema: public; Owner: neondb_owner
--

CREATE SEQUENCE public.withdrawal_rules_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.withdrawal_rules_id_seq OWNER TO neondb_owner;

--
-- Name: withdrawal_rules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: neondb_owner
--

ALTER SEQUENCE public.withdrawal_rules_id_seq OWNED BY public.withdrawal_rules.id;


--
-- Name: withdrawals; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.withdrawals (
    id integer CONSTRAINT "withdrawals _id_not_null" NOT NULL,
    user_id integer CONSTRAINT "withdrawals _user_id_not_null" NOT NULL,
    payment_method_id bigint,
    payment_account_id bigint,
    approved_by_id bigint,
    rejected_by_id bigint,
    account_number character varying(50),
    amount numeric(18,2),
    status character varying(30) DEFAULT 'pending'::character varying,
    rejection_reason character varying(100),
    claimed_by_id bigint,
    claimed_at timestamp without time zone,
    processed_at timestamp without time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    transaction_id bigint,
    rule_id bigint,
    CONSTRAINT withdrawals_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'processing'::character varying, 'approved'::character varying, 'rejected'::character varying, 'failed'::character varying, 'cancelled'::character varying])::text[])))
);


ALTER TABLE public.withdrawals OWNER TO neondb_owner;

--
-- Name: withdrawals _id_seq; Type: SEQUENCE; Schema: public; Owner: neondb_owner
--

CREATE SEQUENCE public."withdrawals _id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public."withdrawals _id_seq" OWNER TO neondb_owner;

--
-- Name: withdrawals _id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: neondb_owner
--

ALTER SEQUENCE public."withdrawals _id_seq" OWNED BY public.withdrawals.id;


--
-- Name: bingo_games id; Type: DEFAULT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_games ALTER COLUMN id SET DEFAULT nextval('public.bingo_games_id_seq'::regclass);


--
-- Name: bingo_participants id; Type: DEFAULT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_participants ALTER COLUMN id SET DEFAULT nextval('public.bingo_participants_id_seq'::regclass);


--
-- Name: bingo_winners id; Type: DEFAULT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_winners ALTER COLUMN id SET DEFAULT nextval('public.bingo_winners_id_seq'::regclass);


--
-- Name: deposit_rules id; Type: DEFAULT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.deposit_rules ALTER COLUMN id SET DEFAULT nextval('public.deposit_rules_id_seq'::regclass);


--
-- Name: deposits id; Type: DEFAULT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.deposits ALTER COLUMN id SET DEFAULT nextval('public.deposit_id_seq'::regclass);


--
-- Name: financial_transactions id; Type: DEFAULT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.financial_transactions ALTER COLUMN id SET DEFAULT nextval('public.financial_transactions_id_seq'::regclass);


--
-- Name: game_systems id; Type: DEFAULT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.game_systems ALTER COLUMN id SET DEFAULT nextval('public.game_systems_id_seq'::regclass);


--
-- Name: ledger_entries id; Type: DEFAULT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.ledger_entries ALTER COLUMN id SET DEFAULT nextval('public.ledger_entries_id_seq'::regclass);


--
-- Name: payment_accounts id; Type: DEFAULT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.payment_accounts ALTER COLUMN id SET DEFAULT nextval('public.deposit_accounts_id_seq'::regclass);


--
-- Name: payment_methods id; Type: DEFAULT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.payment_methods ALTER COLUMN id SET DEFAULT nextval('public.payment_methods_id_seq'::regclass);


--
-- Name: payment_types id; Type: DEFAULT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.payment_types ALTER COLUMN id SET DEFAULT nextval('public.payment_type_id_seq'::regclass);


--
-- Name: transfers id; Type: DEFAULT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.transfers ALTER COLUMN id SET DEFAULT nextval('public.transfers_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: wallets id; Type: DEFAULT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.wallets ALTER COLUMN id SET DEFAULT nextval('public.wallets_id_seq'::regclass);


--
-- Name: withdrawal_rules id; Type: DEFAULT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.withdrawal_rules ALTER COLUMN id SET DEFAULT nextval('public.withdrawal_rules_id_seq'::regclass);


--
-- Name: withdrawals id; Type: DEFAULT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.withdrawals ALTER COLUMN id SET DEFAULT nextval('public."withdrawals _id_seq"'::regclass);


--
-- Name: bingo_participants bingo_participants_game_card_unique; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_participants
    ADD CONSTRAINT bingo_participants_game_card_unique UNIQUE (game_id, card_id);


--
-- Name: bingo_participants bingo_participants_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_participants
    ADD CONSTRAINT bingo_participants_pkey PRIMARY KEY (id);


--
-- Name: bingo_winners bingo_winners_game_id_card_id_key; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_winners
    ADD CONSTRAINT bingo_winners_game_id_card_id_key UNIQUE (game_id, card_id);


--
-- Name: bingo_winners bingo_winners_game_id_participant_id_key; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_winners
    ADD CONSTRAINT bingo_winners_game_id_participant_id_key UNIQUE (game_id, participant_id);


--
-- Name: bingo_winners bingo_winners_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_winners
    ADD CONSTRAINT bingo_winners_pkey PRIMARY KEY (id);


--
-- Name: broadcast_drafts broadcast_drafts_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.broadcast_drafts
    ADD CONSTRAINT broadcast_drafts_pkey PRIMARY KEY (admin_id);


--
-- Name: payment_accounts deposit_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.payment_accounts
    ADD CONSTRAINT deposit_accounts_pkey PRIMARY KEY (id);


--
-- Name: deposits deposit_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.deposits
    ADD CONSTRAINT deposit_pkey PRIMARY KEY (id);


--
-- Name: deposit_rules deposit_rules_code_key; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.deposit_rules
    ADD CONSTRAINT deposit_rules_code_key UNIQUE (code);


--
-- Name: deposit_rules deposit_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.deposit_rules
    ADD CONSTRAINT deposit_rules_pkey PRIMARY KEY (id);


--
-- Name: financial_transactions financial_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.financial_transactions
    ADD CONSTRAINT financial_transactions_pkey PRIMARY KEY (id);


--
-- Name: game_systems game_systems_code_unique; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.game_systems
    ADD CONSTRAINT game_systems_code_unique UNIQUE (code);


--
-- Name: game_systems game_systems_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.game_systems
    ADD CONSTRAINT game_systems_pkey PRIMARY KEY (id);


--
-- Name: bingo_games games_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_games
    ADD CONSTRAINT games_pkey PRIMARY KEY (id);


--
-- Name: ledger_entries ledger_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_pkey PRIMARY KEY (id);


--
-- Name: payment_methods payment_methods_amharic_name_key; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.payment_methods
    ADD CONSTRAINT payment_methods_amharic_name_key UNIQUE (amharic_name);


--
-- Name: payment_methods payment_methods_name_key; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.payment_methods
    ADD CONSTRAINT payment_methods_name_key UNIQUE (name);


--
-- Name: payment_methods payment_methods_order_key; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.payment_methods
    ADD CONSTRAINT payment_methods_order_key UNIQUE ("order");


--
-- Name: payment_methods payment_methods_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.payment_methods
    ADD CONSTRAINT payment_methods_pkey PRIMARY KEY (id);


--
-- Name: payment_types payment_type_name_key; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.payment_types
    ADD CONSTRAINT payment_type_name_key UNIQUE (name);


--
-- Name: payment_types payment_type_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.payment_types
    ADD CONSTRAINT payment_type_pkey PRIMARY KEY (id);


--
-- Name: settings settings_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (key);


--
-- Name: transfers transfers_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.transfers
    ADD CONSTRAINT transfers_pkey PRIMARY KEY (id);


--
-- Name: users users_phone_unique; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_phone_unique UNIQUE (phone);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_telegram_id_key; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_telegram_id_key UNIQUE (telegram_id);


--
-- Name: wallet_balances wallet_balances_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.wallet_balances
    ADD CONSTRAINT wallet_balances_pkey PRIMARY KEY (wallet_id);


--
-- Name: wallets wallets_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.wallets
    ADD CONSTRAINT wallets_pkey PRIMARY KEY (id);


--
-- Name: wallets wallets_user_type_unique; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.wallets
    ADD CONSTRAINT wallets_user_type_unique UNIQUE (user_id, wallet_type);


--
-- Name: withdrawal_rules withdrawal_rules_code_key; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.withdrawal_rules
    ADD CONSTRAINT withdrawal_rules_code_key UNIQUE (code);


--
-- Name: withdrawal_rules withdrawal_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.withdrawal_rules
    ADD CONSTRAINT withdrawal_rules_pkey PRIMARY KEY (id);


--
-- Name: withdrawals withdrawals _pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.withdrawals
    ADD CONSTRAINT "withdrawals _pkey" PRIMARY KEY (id);


--
-- Name: deposits_reference_unique_idx; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE UNIQUE INDEX deposits_reference_unique_idx ON public.deposits USING btree (reference) WHERE (reference IS NOT NULL);


--
-- Name: idx_bingo_games_game_code; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE UNIQUE INDEX idx_bingo_games_game_code ON public.bingo_games USING btree (game_code);


--
-- Name: idx_deposit_rules_account; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_deposit_rules_account ON public.deposit_rules USING btree (payment_account_id);


--
-- Name: idx_deposit_rules_active; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_deposit_rules_active ON public.deposit_rules USING btree (is_active);


--
-- Name: idx_deposit_rules_dates; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_deposit_rules_dates ON public.deposit_rules USING btree (starts_at, ends_at);


--
-- Name: idx_deposit_rules_method; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_deposit_rules_method ON public.deposit_rules USING btree (payment_method_id);


--
-- Name: idx_deposits_created_at; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_deposits_created_at ON public.deposits USING btree (created_at DESC);


--
-- Name: idx_deposits_payment_account_id; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_deposits_payment_account_id ON public.deposits USING btree (payment_account_id);


--
-- Name: idx_deposits_rule; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_deposits_rule ON public.deposits USING btree (rule_id);


--
-- Name: idx_deposits_status; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_deposits_status ON public.deposits USING btree (status);


--
-- Name: idx_deposits_transaction; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_deposits_transaction ON public.deposits USING btree (transaction_id);


--
-- Name: idx_deposits_user_created; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_deposits_user_created ON public.deposits USING btree (user_id, created_at DESC);


--
-- Name: idx_deposits_user_id; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_deposits_user_id ON public.deposits USING btree (user_id);


--
-- Name: idx_financial_transactions_game; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_financial_transactions_game ON public.financial_transactions USING btree (game_system_id, created_at DESC);


--
-- Name: idx_financial_transactions_source; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_financial_transactions_source ON public.financial_transactions USING btree (source_type, source_id);


--
-- Name: idx_financial_transactions_status; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_financial_transactions_status ON public.financial_transactions USING btree (status, created_at DESC);


--
-- Name: idx_financial_transactions_type; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_financial_transactions_type ON public.financial_transactions USING btree (type, created_at DESC);


--
-- Name: idx_financial_transactions_user; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_financial_transactions_user ON public.financial_transactions USING btree (user_id, created_at DESC);


--
-- Name: idx_games_room; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_games_room ON public.bingo_games USING btree (room_id);


--
-- Name: idx_games_status; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_games_status ON public.bingo_games USING btree (status);


--
-- Name: idx_ledger_entries_transaction; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_ledger_entries_transaction ON public.ledger_entries USING btree (transaction_id);


--
-- Name: idx_ledger_entries_wallet; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_ledger_entries_wallet ON public.ledger_entries USING btree (wallet_id, created_at DESC);


--
-- Name: idx_payment_accounts_method_active; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_payment_accounts_method_active ON public.payment_accounts USING btree (payment_method_id, is_active, is_removed);


--
-- Name: idx_transfers_receiver; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_transfers_receiver ON public.transfers USING btree (receiver_user_id, created_at DESC);


--
-- Name: idx_transfers_sender; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_transfers_sender ON public.transfers USING btree (sender_user_id, created_at DESC);


--
-- Name: idx_users_admin_role_active; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_users_admin_role_active ON public.users USING btree (admin_role, is_active, is_banned, is_blocked) WHERE (is_admin = true);


--
-- Name: idx_users_phone; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_users_phone ON public.users USING btree (phone);


--
-- Name: idx_users_telegram; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_users_telegram ON public.users USING btree (telegram_id);


--
-- Name: idx_wallets_type; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_wallets_type ON public.wallets USING btree (wallet_type);


--
-- Name: idx_wallets_user; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_wallets_user ON public.wallets USING btree (user_id);


--
-- Name: idx_withdrawal_rules_account; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_withdrawal_rules_account ON public.withdrawal_rules USING btree (payment_account_id);


--
-- Name: idx_withdrawal_rules_active; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_withdrawal_rules_active ON public.withdrawal_rules USING btree (is_active);


--
-- Name: idx_withdrawal_rules_dates; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_withdrawal_rules_dates ON public.withdrawal_rules USING btree (starts_at, ends_at);


--
-- Name: idx_withdrawal_rules_method; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_withdrawal_rules_method ON public.withdrawal_rules USING btree (payment_method_id);


--
-- Name: idx_withdrawals_claimed; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_withdrawals_claimed ON public.withdrawals USING btree (claimed_by_id, claimed_at) WHERE ((status)::text = 'processing'::text);


--
-- Name: idx_withdrawals_queue; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_withdrawals_queue ON public.withdrawals USING btree (payment_method_id, created_at, id) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_withdrawals_rule; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_withdrawals_rule ON public.withdrawals USING btree (rule_id);


--
-- Name: idx_withdrawals_transaction; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_withdrawals_transaction ON public.withdrawals USING btree (transaction_id);


--
-- Name: idx_withdrawals_user; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_withdrawals_user ON public.withdrawals USING btree (user_id, created_at DESC);


--
-- Name: idx_withdrawals_user_id; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_withdrawals_user_id ON public.withdrawals USING btree (user_id);


--
-- Name: uq_financial_transactions_idempotency; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE UNIQUE INDEX uq_financial_transactions_idempotency ON public.financial_transactions USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: uq_financial_transactions_reversal; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE UNIQUE INDEX uq_financial_transactions_reversal ON public.financial_transactions USING btree (reversed_transaction_id) WHERE (reversed_transaction_id IS NOT NULL);


--
-- Name: ux_deposits_transaction; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE UNIQUE INDEX ux_deposits_transaction ON public.deposits USING btree (transaction_id) WHERE (transaction_id IS NOT NULL);


--
-- Name: ux_withdrawals_transaction; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE UNIQUE INDEX ux_withdrawals_transaction ON public.withdrawals USING btree (transaction_id) WHERE (transaction_id IS NOT NULL);


--
-- Name: deposit_rules deposit_rules_set_updated_at; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER deposit_rules_set_updated_at BEFORE UPDATE ON public.deposit_rules FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: deposits deposits_set_updated_at; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER deposits_set_updated_at BEFORE UPDATE ON public.deposits FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: users users_create_wallets; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER users_create_wallets AFTER INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.create_user_wallets();


--
-- Name: users users_set_updated_at; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: withdrawal_rules withdrawal_rules_set_updated_at; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER withdrawal_rules_set_updated_at BEFORE UPDATE ON public.withdrawal_rules FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: withdrawals withdrawals_set_updated_at; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER withdrawals_set_updated_at BEFORE UPDATE ON public.withdrawals FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: bingo_participants bingo_participants_game_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_participants
    ADD CONSTRAINT bingo_participants_game_id_fkey FOREIGN KEY (game_id) REFERENCES public.bingo_games(id) ON DELETE RESTRICT;


--
-- Name: bingo_participants bingo_participants_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_participants
    ADD CONSTRAINT bingo_participants_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.financial_transactions(id) ON DELETE RESTRICT;


--
-- Name: bingo_participants bingo_participants_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_participants
    ADD CONSTRAINT bingo_participants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: bingo_winners bingo_winners_game_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_winners
    ADD CONSTRAINT bingo_winners_game_id_fkey FOREIGN KEY (game_id) REFERENCES public.bingo_games(id) ON DELETE RESTRICT;


--
-- Name: bingo_winners bingo_winners_participant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_winners
    ADD CONSTRAINT bingo_winners_participant_id_fkey FOREIGN KEY (participant_id) REFERENCES public.bingo_participants(id) ON DELETE RESTRICT;


--
-- Name: bingo_winners bingo_winners_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_winners
    ADD CONSTRAINT bingo_winners_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.financial_transactions(id) ON DELETE RESTRICT;


--
-- Name: bingo_winners bingo_winners_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_winners
    ADD CONSTRAINT bingo_winners_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: payment_accounts deposit_accounts_payment_method_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.payment_accounts
    ADD CONSTRAINT deposit_accounts_payment_method_id_fkey FOREIGN KEY (payment_method_id) REFERENCES public.payment_methods(id);


--
-- Name: deposit_rules deposit_rules_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.deposit_rules
    ADD CONSTRAINT deposit_rules_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: deposit_rules deposit_rules_payment_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.deposit_rules
    ADD CONSTRAINT deposit_rules_payment_account_id_fkey FOREIGN KEY (payment_account_id) REFERENCES public.payment_accounts(id) ON DELETE RESTRICT;


--
-- Name: deposit_rules deposit_rules_payment_method_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.deposit_rules
    ADD CONSTRAINT deposit_rules_payment_method_id_fkey FOREIGN KEY (payment_method_id) REFERENCES public.payment_methods(id) ON DELETE RESTRICT;


--
-- Name: deposits deposit_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.deposits
    ADD CONSTRAINT deposit_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: deposits deposits_approved_by_fk; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.deposits
    ADD CONSTRAINT deposits_approved_by_fk FOREIGN KEY (approved_by_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: deposits deposits_payment_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.deposits
    ADD CONSTRAINT deposits_payment_account_id_fkey FOREIGN KEY (payment_account_id) REFERENCES public.payment_accounts(id);


--
-- Name: deposits deposits_payment_method_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.deposits
    ADD CONSTRAINT deposits_payment_method_id_fkey FOREIGN KEY (deposit_method_id) REFERENCES public.payment_methods(id);


--
-- Name: deposits deposits_rejected_by_fk; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.deposits
    ADD CONSTRAINT deposits_rejected_by_fk FOREIGN KEY (rejected_by_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: deposits deposits_rule_fk; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.deposits
    ADD CONSTRAINT deposits_rule_fk FOREIGN KEY (rule_id) REFERENCES public.deposit_rules(id) ON DELETE SET NULL;


--
-- Name: deposits deposits_transaction_fk; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.deposits
    ADD CONSTRAINT deposits_transaction_fk FOREIGN KEY (transaction_id) REFERENCES public.financial_transactions(id) ON DELETE RESTRICT;


--
-- Name: financial_transactions financial_transactions_game_system_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.financial_transactions
    ADD CONSTRAINT financial_transactions_game_system_id_fkey FOREIGN KEY (game_system_id) REFERENCES public.game_systems(id) ON DELETE RESTRICT;


--
-- Name: financial_transactions financial_transactions_reversed_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.financial_transactions
    ADD CONSTRAINT financial_transactions_reversed_transaction_id_fkey FOREIGN KEY (reversed_transaction_id) REFERENCES public.financial_transactions(id) ON DELETE RESTRICT;


--
-- Name: financial_transactions financial_transactions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.financial_transactions
    ADD CONSTRAINT financial_transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: withdrawals fk_withdrawals_approved_by; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.withdrawals
    ADD CONSTRAINT fk_withdrawals_approved_by FOREIGN KEY (approved_by_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: withdrawals fk_withdrawals_claimed_by; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.withdrawals
    ADD CONSTRAINT fk_withdrawals_claimed_by FOREIGN KEY (claimed_by_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: withdrawals fk_withdrawals_payment_account; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.withdrawals
    ADD CONSTRAINT fk_withdrawals_payment_account FOREIGN KEY (payment_account_id) REFERENCES public.payment_accounts(id) ON DELETE SET NULL;


--
-- Name: withdrawals fk_withdrawals_payment_method; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.withdrawals
    ADD CONSTRAINT fk_withdrawals_payment_method FOREIGN KEY (payment_method_id) REFERENCES public.payment_methods(id) ON DELETE RESTRICT;


--
-- Name: withdrawals fk_withdrawals_rejected_by; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.withdrawals
    ADD CONSTRAINT fk_withdrawals_rejected_by FOREIGN KEY (rejected_by_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: withdrawals fk_withdrawals_user; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.withdrawals
    ADD CONSTRAINT fk_withdrawals_user FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: ledger_entries ledger_entries_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.financial_transactions(id) ON DELETE RESTRICT;


--
-- Name: ledger_entries ledger_entries_wallet_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_wallet_id_fkey FOREIGN KEY (wallet_id) REFERENCES public.wallets(id) ON DELETE RESTRICT;


--
-- Name: payment_methods payment_methods_type_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.payment_methods
    ADD CONSTRAINT payment_methods_type_fkey FOREIGN KEY (type_id) REFERENCES public.payment_types(id);


--
-- Name: transfers transfers_receiver_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.transfers
    ADD CONSTRAINT transfers_receiver_user_id_fkey FOREIGN KEY (receiver_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: transfers transfers_sender_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.transfers
    ADD CONSTRAINT transfers_sender_user_id_fkey FOREIGN KEY (sender_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: transfers transfers_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.transfers
    ADD CONSTRAINT transfers_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.financial_transactions(id) ON DELETE RESTRICT;


--
-- Name: wallet_balances wallet_balances_wallet_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.wallet_balances
    ADD CONSTRAINT wallet_balances_wallet_id_fkey FOREIGN KEY (wallet_id) REFERENCES public.wallets(id) ON DELETE RESTRICT;


--
-- Name: wallets wallets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.wallets
    ADD CONSTRAINT wallets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: withdrawal_rules withdrawal_rules_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.withdrawal_rules
    ADD CONSTRAINT withdrawal_rules_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: withdrawal_rules withdrawal_rules_payment_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.withdrawal_rules
    ADD CONSTRAINT withdrawal_rules_payment_account_id_fkey FOREIGN KEY (payment_account_id) REFERENCES public.payment_accounts(id) ON DELETE RESTRICT;


--
-- Name: withdrawal_rules withdrawal_rules_payment_method_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.withdrawal_rules
    ADD CONSTRAINT withdrawal_rules_payment_method_id_fkey FOREIGN KEY (payment_method_id) REFERENCES public.payment_methods(id) ON DELETE RESTRICT;


--
-- Name: withdrawals withdrawals_rule_fk; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.withdrawals
    ADD CONSTRAINT withdrawals_rule_fk FOREIGN KEY (rule_id) REFERENCES public.withdrawal_rules(id) ON DELETE SET NULL;


--
-- Name: withdrawals withdrawals_transaction_fk; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.withdrawals
    ADD CONSTRAINT withdrawals_transaction_fk FOREIGN KEY (transaction_id) REFERENCES public.financial_transactions(id) ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--
