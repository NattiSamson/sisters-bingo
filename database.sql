--
-- PostgreSQL database dump
--



-- Dumped from database version 18.6 (4e955f5)
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
-- Name: award_bonus(integer, bigint, numeric, character varying, character varying, character varying, text, jsonb); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.award_bonus(p_user_id integer, p_campaign_id bigint, p_amount numeric, p_source_type character varying, p_source_id character varying, p_idempotency_key character varying, p_description text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb) RETURNS TABLE(bonus_id bigint, transaction_id bigint)
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_campaign public.bonus_campaigns%ROWTYPE;

    v_wallet_id BIGINT;
    v_transaction_id BIGINT;
    v_transaction_created BOOLEAN;
    v_bonus_id BIGINT;

    v_base_amount NUMERIC(18,2);
    v_bonus_amount NUMERIC(18,2);
    v_wagering_requirement NUMERIC(18,2);

    v_expires_at TIMESTAMPTZ;
    v_effective_metadata JSONB;

    v_existing_bonus_id BIGINT;
BEGIN
    ----------------------------------------------------------------
    -- 1. Validate user
    ----------------------------------------------------------------
    IF p_user_id IS NULL OR p_user_id <= 0 THEN
        RAISE EXCEPTION 'Invalid user ID';
    END IF;

    ----------------------------------------------------------------
    -- 2. Validate campaign ID
    ----------------------------------------------------------------
    IF p_campaign_id IS NULL OR p_campaign_id <= 0 THEN
        RAISE EXCEPTION 'Invalid bonus campaign ID';
    END IF;

    ----------------------------------------------------------------
    -- 3. Validate idempotency key
    ----------------------------------------------------------------
    IF p_idempotency_key IS NULL
       OR BTRIM(p_idempotency_key) = '' THEN
        RAISE EXCEPTION 'Bonus idempotency key is required';
    END IF;

    ----------------------------------------------------------------
    -- 4. Base amount
    --
    -- p_amount represents the qualifying amount.
    --
    -- Examples:
    --   Deposit bonus  -> deposit amount
    --   Reload bonus   -> reload deposit amount
    --   Welcome fixed  -> can be 0
    --   No-deposit     -> can be 0
    ----------------------------------------------------------------
    v_base_amount := ROUND(
        COALESCE(p_amount, 0),
        2
    );

    IF v_base_amount < 0 THEN
        RAISE EXCEPTION 'Base amount cannot be negative';
    END IF;

    ----------------------------------------------------------------
    -- 5. Load and lock campaign
    ----------------------------------------------------------------
    SELECT *
    INTO v_campaign
    FROM public.bonus_campaigns
    WHERE id = p_campaign_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Bonus campaign % was not found',
            p_campaign_id;
    END IF;

    ----------------------------------------------------------------
    -- 6. Validate campaign status
    ----------------------------------------------------------------
    IF NOT v_campaign.is_active THEN
        RAISE EXCEPTION
            'Bonus campaign % is not active',
            p_campaign_id;
    END IF;

    IF v_campaign.starts_at IS NOT NULL
       AND v_campaign.starts_at > NOW() THEN
        RAISE EXCEPTION
            'Bonus campaign % has not started',
            p_campaign_id;
    END IF;

    IF v_campaign.ends_at IS NOT NULL
       AND v_campaign.ends_at < NOW() THEN
        RAISE EXCEPTION
            'Bonus campaign % has expired',
            p_campaign_id;
    END IF;

    ----------------------------------------------------------------
    -- 7. Idempotency check at bonus level
    --
    -- This prevents creating a duplicate user_bonus if the same
    -- request has already been processed.
    ----------------------------------------------------------------
    SELECT ub.id
    INTO v_existing_bonus_id
    FROM public.user_bonuses ub
    WHERE ub.idempotency_key = p_idempotency_key
    LIMIT 1;

    IF v_existing_bonus_id IS NOT NULL THEN

        SELECT ft.id
        INTO v_transaction_id
        FROM public.financial_transactions ft
        WHERE ft.idempotency_key = p_idempotency_key
        LIMIT 1;

        IF v_transaction_id IS NULL THEN
            RAISE EXCEPTION
                'Bonus % exists but its financial transaction was not found',
                v_existing_bonus_id;
        END IF;

        RETURN QUERY
        SELECT
            v_existing_bonus_id,
            v_transaction_id;

        RETURN;
    END IF;

    ----------------------------------------------------------------
    -- 8. Validate minimum deposit
    --
    -- This applies to deposit/reload bonuses.
    -- The value being checked is the qualifying deposit amount,
    -- NOT the user's wallet balance.
    ----------------------------------------------------------------
    IF v_campaign.bonus_type IN ('deposit', 'reload')
       AND v_campaign.min_deposit_amount IS NOT NULL
       AND v_base_amount < v_campaign.min_deposit_amount THEN

        RAISE EXCEPTION
            'Deposit amount % does not meet minimum deposit requirement of % for campaign %',
            v_base_amount,
            v_campaign.min_deposit_amount,
            v_campaign.id;
    END IF;

    ----------------------------------------------------------------
    -- 9. Calculate actual bonus amount
    --
    -- Priority:
    --   multiplier
    --   percentage
    --   fixed amount
    --
    -- Only ONE of these should normally be configured on a campaign.
    ----------------------------------------------------------------

    IF v_campaign.multiplier IS NOT NULL THEN

        ------------------------------------------------------------
        -- Multiplier bonus
        --
        -- Example:
        --   deposit = 100
        --   multiplier = 2
        --   bonus = 200
        ------------------------------------------------------------
        v_bonus_amount := ROUND(
            v_base_amount * v_campaign.multiplier,
            2
        );

    ELSIF v_campaign.percentage IS NOT NULL THEN

        ------------------------------------------------------------
        -- Percentage bonus
        --
        -- Example:
        --   deposit = 100
        --   percentage = 50
        --   bonus = 50
        ------------------------------------------------------------
        v_bonus_amount := ROUND(
            v_base_amount
            * v_campaign.percentage
            / 100,
            2
        );

    ELSIF v_campaign.amount IS NOT NULL THEN

        ------------------------------------------------------------
        -- Fixed bonus
        --
        -- Example:
        --   amount = 100
        --   bonus = 100
        ------------------------------------------------------------
        v_bonus_amount := ROUND(
            v_campaign.amount,
            2
        );

    ELSE

        RAISE EXCEPTION
            'Campaign % has no bonus calculation configured. Set amount, percentage, or multiplier.',
            v_campaign.id;

    END IF;

    ----------------------------------------------------------------
    -- 10. Validate calculated bonus
    ----------------------------------------------------------------
    IF v_bonus_amount IS NULL OR v_bonus_amount <= 0 THEN
        RAISE EXCEPTION
            'Calculated bonus amount must be greater than zero for campaign %',
            v_campaign.id;
    END IF;

    ----------------------------------------------------------------
    -- 11. Apply maximum bonus cap
    ----------------------------------------------------------------
    IF v_campaign.max_bonus_amount IS NOT NULL THEN

        v_bonus_amount := LEAST(
            v_bonus_amount,
            ROUND(v_campaign.max_bonus_amount, 2)
        );

    END IF;

    ----------------------------------------------------------------
    -- 12. Final bonus amount validation
    ----------------------------------------------------------------
    v_bonus_amount := ROUND(
        GREATEST(v_bonus_amount, 0),
        2
    );

    IF v_bonus_amount <= 0 THEN
        RAISE EXCEPTION
            'Calculated bonus amount is zero after applying campaign limits';
    END IF;

    ----------------------------------------------------------------
    -- 13. Resolve Bonus wallet
    ----------------------------------------------------------------
    v_wallet_id := public.get_user_wallet_id(
        p_user_id,
        'bonus'
    );

    IF v_wallet_id IS NULL THEN
        RAISE EXCEPTION
            'Bonus wallet not found for user %',
            p_user_id;
    END IF;

    ----------------------------------------------------------------
    -- 14. Lock Bonus wallet
    ----------------------------------------------------------------
    PERFORM public.lock_wallet(v_wallet_id);

    ----------------------------------------------------------------
    -- 15. Calculate wagering requirement
    --
    -- This is DIFFERENT from the bonus calculation multiplier.
    --
    -- Example:
    --   bonus = 100
    --   wagering_multiplier = 5
    --   wagering requirement = 500
    ----------------------------------------------------------------
    v_wagering_requirement := ROUND(
        v_bonus_amount
        * v_campaign.wagering_multiplier,
        2
    );

    ----------------------------------------------------------------
    -- 16. Calculate expiration
    ----------------------------------------------------------------
    IF v_campaign.validity_hours IS NOT NULL THEN

        v_expires_at :=
            NOW()
            + (
                v_campaign.validity_hours
                * INTERVAL '1 hour'
            );

    ELSE

        v_expires_at := NULL;

    END IF;

    ----------------------------------------------------------------
    -- 17. Build transaction metadata
    ----------------------------------------------------------------
    v_effective_metadata :=
        COALESCE(
            p_metadata,
            '{}'::JSONB
        )
        ||
        jsonb_build_object(
            'bonus_campaign_id',
                p_campaign_id,

            'bonus_campaign_code',
                v_campaign.code,

            'bonus_campaign_name',
                v_campaign.name,

            'bonus_type',
                v_campaign.bonus_type,

            'base_amount',
                v_base_amount,

            'bonus_amount',
                v_bonus_amount,

            'campaign_amount',
                v_campaign.amount,

            'campaign_percentage',
                v_campaign.percentage,

            'campaign_multiplier',
                v_campaign.multiplier,

            'min_deposit_amount',
                v_campaign.min_deposit_amount,

            'max_bonus_amount',
                v_campaign.max_bonus_amount,

            'wagering_multiplier',
                v_campaign.wagering_multiplier,

            'wagering_requirement',
                v_wagering_requirement
        );

    ----------------------------------------------------------------
    -- 18. Create financial transaction
    ----------------------------------------------------------------
    SELECT
        t.transaction_id,
        t.created
    INTO
        v_transaction_id,
        v_transaction_created
    FROM public.create_financial_transaction(
        p_user_id,
        'bonus',
        'completed',
        v_campaign.game_system_id,
        p_source_type,
        p_source_id,
        p_idempotency_key,
        p_description,
        v_effective_metadata
    ) AS t;

    ----------------------------------------------------------------
    -- 19. Handle idempotent transaction retry
    ----------------------------------------------------------------
    IF NOT v_transaction_created THEN

        SELECT ub.id
        INTO v_bonus_id
        FROM public.user_bonuses ub
        WHERE ub.idempotency_key = p_idempotency_key
        LIMIT 1;

        IF v_bonus_id IS NULL THEN
            RAISE EXCEPTION
                'Bonus transaction % exists but user bonus was not found',
                v_transaction_id;
        END IF;

        RETURN QUERY
        SELECT
            v_bonus_id,
            v_transaction_id;

        RETURN;

    END IF;

    ----------------------------------------------------------------
    -- 20. Create user bonus entitlement
    ----------------------------------------------------------------
    INSERT INTO public.user_bonuses (
        user_id,
        campaign_id,
        status,
        awarded_amount,
        wagering_requirement,
        wagering_progress,
        remaining_amount,
        expires_at,
        awarded_at,
        activated_at,
        source_type,
        source_id,
        idempotency_key,
        metadata
    )
    VALUES (
        p_user_id,
        p_campaign_id,
        'active',

        v_bonus_amount,

        v_wagering_requirement,

        0,

        v_bonus_amount,

        v_expires_at,

        NOW(),

        NOW(),

        p_source_type,

        p_source_id,

        p_idempotency_key,

        v_effective_metadata
    )
    RETURNING id
    INTO v_bonus_id;

    ----------------------------------------------------------------
    -- 21. Credit Bonus ledger
    ----------------------------------------------------------------
    INSERT INTO public.ledger_entries (
        transaction_id,
        wallet_id,
        amount
    )
    VALUES (
        v_transaction_id,
        v_wallet_id,
        v_bonus_amount
    );

    ----------------------------------------------------------------
    -- 22. Credit Bonus wallet
    ----------------------------------------------------------------
    UPDATE public.wallet_balances
    SET
        balance = balance + v_bonus_amount,
        updated_at = NOW()
    WHERE wallet_id = v_wallet_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Wallet balance % not found while awarding bonus',
            v_wallet_id;
    END IF;

    ----------------------------------------------------------------
    -- 23. Return IDs
    ----------------------------------------------------------------
    RETURN QUERY
    SELECT
        v_bonus_id,
        v_transaction_id;

END;
$$;


ALTER FUNCTION public.award_bonus(p_user_id integer, p_campaign_id bigint, p_amount numeric, p_source_type character varying, p_source_id character varying, p_idempotency_key character varying, p_description text, p_metadata jsonb) OWNER TO neondb_owner;

--
-- Name: complete_bonus_wagering(bigint); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.complete_bonus_wagering(p_user_bonus_id bigint) RETURNS numeric
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_bonus public.user_bonuses%ROWTYPE;
    v_convertible_amount NUMERIC(18,2);
BEGIN
    IF p_user_bonus_id IS NULL THEN
        RAISE EXCEPTION 'User bonus ID is required';
    END IF;

    SELECT *
    INTO v_bonus
    FROM public.user_bonuses
    WHERE id = p_user_bonus_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'User bonus % does not exist',
            p_user_bonus_id;
    END IF;

    IF v_bonus.status = 'completed' THEN
        RETURN v_bonus.convertible_amount;
    END IF;

    IF v_bonus.status <> 'active' THEN
        RAISE EXCEPTION
            'User bonus % is not active. Current status: %',
            p_user_bonus_id,
            v_bonus.status;
    END IF;

    IF v_bonus.wagering_progress < v_bonus.wagering_requirement THEN
        RAISE EXCEPTION
            'Bonus % has not completed wagering. Progress: %, Required: %',
            p_user_bonus_id,
            v_bonus.wagering_progress,
            v_bonus.wagering_requirement;
    END IF;

    /*
     * Only bonus funds still remaining after wagering can be
     * converted to Main.
     *
     * The amount already consumed for stakes is not itself
     * recreated as withdrawable money.
     */
    v_convertible_amount := ROUND(
        GREATEST(v_bonus.remaining_amount, 0),
        2
    );

    UPDATE public.user_bonuses
    SET
        convertible_amount = v_convertible_amount,
        status = 'completed',
        completed_at = NOW(),
        updated_at = NOW()
    WHERE id = p_user_bonus_id;

    RETURN v_convertible_amount;
END;
$$;


ALTER FUNCTION public.complete_bonus_wagering(p_user_bonus_id bigint) OWNER TO neondb_owner;

--
-- Name: consume_bonus_for_stake(integer, bigint, numeric); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.consume_bonus_for_stake(p_user_id integer, p_stake_transaction_id bigint, p_bonus_amount numeric) RETURNS TABLE(consumed_amount numeric, wagering_amount numeric)
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_remaining NUMERIC(18,2);
    v_available NUMERIC(18,2);
    v_consume NUMERIC(18,2);

    v_total_consumed NUMERIC(18,2) := 0;
    v_total_wagering NUMERIC(18,2) := 0;

    v_bonus RECORD;
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'User ID is required';
    END IF;

    IF p_stake_transaction_id IS NULL THEN
        RAISE EXCEPTION 'Stake transaction ID is required';
    END IF;

    IF p_bonus_amount IS NULL OR p_bonus_amount <= 0 THEN
        consumed_amount := 0;
        wagering_amount := 0;
        RETURN NEXT;
        RETURN;
    END IF;

    ----------------------------------------------------------------
    -- Verify the stake transaction
    ----------------------------------------------------------------
    PERFORM 1
    FROM public.financial_transactions ft
    WHERE ft.id = p_stake_transaction_id
      AND ft.user_id = p_user_id
      AND ft.type = 'stake'
      AND ft.status = 'completed';

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Stake transaction % does not exist, does not belong to user %, or is not a completed stake',
            p_stake_transaction_id,
            p_user_id;
    END IF;

    ----------------------------------------------------------------
    -- Amount actually funded by Bonus
    ----------------------------------------------------------------
    v_remaining := ROUND(p_bonus_amount, 2);

    ----------------------------------------------------------------
    -- Consume active bonuses, oldest expiry first
    ----------------------------------------------------------------
    FOR v_bonus IN
        SELECT
            ub.id,
            ub.awarded_amount,
            ub.wagering_requirement,
            ub.wagering_progress,
            ub.remaining_amount,
            ub.expires_at
        FROM public.user_bonuses ub
        WHERE ub.user_id = p_user_id
          AND ub.status = 'active'
          AND ub.remaining_amount > 0
          AND (
              ub.expires_at IS NULL
              OR ub.expires_at >= NOW()
          )
        ORDER BY
            CASE
                WHEN ub.expires_at IS NULL THEN 1
                ELSE 0
            END,
            ub.expires_at ASC,
            ub.id ASC
        FOR UPDATE
    LOOP
        EXIT WHEN v_remaining <= 0;

        v_available := ROUND(
            v_bonus.remaining_amount,
            2
        );

        v_consume := LEAST(
            v_remaining,
            v_available
        );

        IF v_consume <= 0 THEN
            CONTINUE;
        END IF;

        ----------------------------------------------------------------
        -- Current rule:
        -- 1 ETB Bonus consumed = 1 ETB qualifying wagering.
        ----------------------------------------------------------------
        INSERT INTO public.user_bonus_consumptions (
            user_bonus_id,
            stake_transaction_id,
            amount,
            wagering_amount
        )
        VALUES (
            v_bonus.id,
            p_stake_transaction_id,
            v_consume,
            v_consume
        )
        ON CONFLICT (user_bonus_id, stake_transaction_id)
        DO UPDATE
        SET
            amount = EXCLUDED.amount,
            wagering_amount = EXCLUDED.wagering_amount;

        ----------------------------------------------------------------
        -- Update bonus entitlement
        ----------------------------------------------------------------
        UPDATE public.user_bonuses
        SET
            remaining_amount = GREATEST(
                remaining_amount - v_consume,
                0
            ),
            wagering_progress = LEAST(
                wagering_requirement,
                wagering_progress + v_consume
            ),
            updated_at = NOW()
        WHERE id = v_bonus.id;

        ----------------------------------------------------------------
        -- Accumulate results
        ----------------------------------------------------------------
        v_remaining := ROUND(
            v_remaining - v_consume,
            2
        );

        v_total_consumed := ROUND(
            v_total_consumed + v_consume,
            2
        );

        v_total_wagering := ROUND(
            v_total_wagering + v_consume,
            2
        );
    END LOOP;

    ----------------------------------------------------------------
    -- Return both values
    ----------------------------------------------------------------
    consumed_amount := v_total_consumed;
    wagering_amount := v_total_wagering;

    RETURN NEXT;
    RETURN;
END;
$$;


ALTER FUNCTION public.consume_bonus_for_stake(p_user_id integer, p_stake_transaction_id bigint, p_bonus_amount numeric) OWNER TO neondb_owner;

--
-- Name: convert_bonus_to_main(bigint); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.convert_bonus_to_main(p_user_bonus_id bigint) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_bonus public.user_bonuses%ROWTYPE;
    v_campaign public.bonus_campaigns%ROWTYPE;

    v_bonus_wallet_id BIGINT;
    v_main_wallet_id BIGINT;

    v_bonus_balance NUMERIC(18,2);
    v_main_balance NUMERIC(18,2);

    v_conversion_base NUMERIC(18,2);
    v_conversion_amount NUMERIC(18,2);

    v_transaction_id BIGINT;
    v_transaction_created BOOLEAN;

    v_idempotency_key VARCHAR(255);
    v_metadata JSONB;
BEGIN

    ----------------------------------------------------------------
    -- 1. Validate input
    ----------------------------------------------------------------
    IF p_user_bonus_id IS NULL THEN
        RAISE EXCEPTION
            'User bonus ID is required';
    END IF;


    ----------------------------------------------------------------
    -- 2. Lock the bonus
    --
    -- This serializes conversion attempts for the same bonus.
    ----------------------------------------------------------------
    SELECT *
    INTO v_bonus
    FROM public.user_bonuses
    WHERE id = p_user_bonus_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'User bonus % does not exist',
            p_user_bonus_id;
    END IF;


    ----------------------------------------------------------------
    -- 3. Deterministic idempotency key
    ----------------------------------------------------------------
    v_idempotency_key :=
        'bonus-conversion:' || p_user_bonus_id::VARCHAR;


    ----------------------------------------------------------------
    -- 4. Return existing transaction if already converted
    ----------------------------------------------------------------
    SELECT ft.id
    INTO v_transaction_id
    FROM public.financial_transactions ft
    WHERE ft.idempotency_key = v_idempotency_key
    FOR UPDATE;

    IF FOUND THEN
        RETURN v_transaction_id;
    END IF;


    ----------------------------------------------------------------
    -- 5. Bonus must be completed
    ----------------------------------------------------------------
    IF v_bonus.status <> 'completed' THEN
        RAISE EXCEPTION
            'Bonus % is not ready for conversion. Current status: %',
            p_user_bonus_id,
            v_bonus.status;
    END IF;


    ----------------------------------------------------------------
    -- 6. Wagering must be complete
    ----------------------------------------------------------------
    IF v_bonus.wagering_progress < v_bonus.wagering_requirement THEN
        RAISE EXCEPTION
            'Bonus % has incomplete wagering. Progress: %, Required: %',
            p_user_bonus_id,
            v_bonus.wagering_progress,
            v_bonus.wagering_requirement;
    END IF;


    ----------------------------------------------------------------
    -- 7. Validate conversion state
    ----------------------------------------------------------------
    IF v_bonus.converted_amount > v_bonus.convertible_amount THEN
        RAISE EXCEPTION
            'Bonus % has invalid conversion state. Converted: %, Convertible: %',
            p_user_bonus_id,
            v_bonus.converted_amount,
            v_bonus.convertible_amount;
    END IF;


    ----------------------------------------------------------------
    -- 8. Load campaign
    ----------------------------------------------------------------
    SELECT *
    INTO v_campaign
    FROM public.bonus_campaigns
    WHERE id = v_bonus.campaign_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Bonus campaign % does not exist',
            v_bonus.campaign_id;
    END IF;


    ----------------------------------------------------------------
    -- 9. Calculate amount currently eligible for conversion
    ----------------------------------------------------------------
    v_conversion_base := ROUND(
        GREATEST(
            COALESCE(v_bonus.convertible_amount, 0)
            - COALESCE(v_bonus.converted_amount, 0),
            0
        ),
        2
    );


    ----------------------------------------------------------------
    -- 10. Apply campaign conversion rule
    --
    -- percentage:
    --     Convert a percentage of the eligible amount.
    --
    -- fixed:
    --     Convert a fixed amount, but never more than
    --     the eligible amount.
    --
    -- none:
    --     Do not convert anything.
    ----------------------------------------------------------------
    CASE v_campaign.conversion_type

        WHEN 'percentage' THEN

            v_conversion_amount := ROUND(
                v_conversion_base
                * COALESCE(
                    v_campaign.conversion_percentage,
                    0
                )
                / 100,
                2
            );


        WHEN 'fixed' THEN

            v_conversion_amount := LEAST(
                v_conversion_base,
                ROUND(
                    COALESCE(
                        v_campaign.conversion_amount,
                        0
                    ),
                    2
                )
            );


        WHEN 'none' THEN

            v_conversion_amount := 0.00;


        ELSE

            RAISE EXCEPTION
                'Unsupported conversion type "%" for campaign %',
                v_campaign.conversion_type,
                v_campaign.id;

    END CASE;


    ----------------------------------------------------------------
    -- 11. Apply optional maximum conversion cap
    ----------------------------------------------------------------
    IF v_campaign.conversion_max_amount IS NOT NULL THEN

        v_conversion_amount := LEAST(
            v_conversion_amount,
            v_campaign.conversion_max_amount
        );

    END IF;


    ----------------------------------------------------------------
    -- 12. Normalize amount
    ----------------------------------------------------------------
    v_conversion_amount := ROUND(
        GREATEST(
            COALESCE(v_conversion_amount, 0),
            0
        ),
        2
    );


    ----------------------------------------------------------------
    -- 13. Safety check
    ----------------------------------------------------------------
    IF v_conversion_amount > v_conversion_base THEN

        RAISE EXCEPTION
            'Calculated conversion % exceeds eligible amount %',
            v_conversion_amount,
            v_conversion_base;

    END IF;


    ----------------------------------------------------------------
    -- 14. Find Bonus wallet
    ----------------------------------------------------------------
    SELECT id
    INTO v_bonus_wallet_id
    FROM public.wallets
    WHERE user_id = v_bonus.user_id
      AND wallet_type = 'bonus'
      AND is_active = TRUE
    LIMIT 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Active Bonus wallet not found for user %',
            v_bonus.user_id;
    END IF;


    ----------------------------------------------------------------
    -- 15. Find Main wallet
    ----------------------------------------------------------------
    SELECT id
    INTO v_main_wallet_id
    FROM public.wallets
    WHERE user_id = v_bonus.user_id
      AND wallet_type = 'main'
      AND is_active = TRUE
    LIMIT 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Active Main wallet not found for user %',
            v_bonus.user_id;
    END IF;


    ----------------------------------------------------------------
    -- 16. Lock both wallet balances deterministically
    --
    -- Lock order is based on wallet ID to reduce deadlock risk.
    ----------------------------------------------------------------
    IF v_bonus_wallet_id < v_main_wallet_id THEN

        SELECT balance
        INTO v_bonus_balance
        FROM public.wallet_balances
        WHERE wallet_id = v_bonus_wallet_id
        FOR UPDATE;


        SELECT balance
        INTO v_main_balance
        FROM public.wallet_balances
        WHERE wallet_id = v_main_wallet_id
        FOR UPDATE;

    ELSE

        SELECT balance
        INTO v_main_balance
        FROM public.wallet_balances
        WHERE wallet_id = v_main_wallet_id
        FOR UPDATE;


        SELECT balance
        INTO v_bonus_balance
        FROM public.wallet_balances
        WHERE wallet_id = v_bonus_wallet_id
        FOR UPDATE;

    END IF;


    ----------------------------------------------------------------
    -- 17. Verify wallet balance rows exist
    ----------------------------------------------------------------
    IF v_bonus_balance IS NULL THEN
        RAISE EXCEPTION
            'Bonus wallet balance row not found for wallet %',
            v_bonus_wallet_id;
    END IF;


    IF v_main_balance IS NULL THEN
        RAISE EXCEPTION
            'Main wallet balance row not found for wallet %',
            v_main_wallet_id;
    END IF;


    ----------------------------------------------------------------
    -- 18. The actual Bonus wallet must contain the money
    --
    -- Never create Main wallet money purely from the bonus
    -- entitlement record.
    ----------------------------------------------------------------
    IF v_conversion_amount > v_bonus_balance THEN

        RAISE EXCEPTION
            'Insufficient Bonus wallet balance for conversion. Required: %, Available: %',
            v_conversion_amount,
            v_bonus_balance;

    END IF;


    ----------------------------------------------------------------
    -- 19. Build transaction metadata
    ----------------------------------------------------------------
    v_metadata := jsonb_build_object(
        'operation',
        'bonus_conversion',

        'user_bonus_id',
        v_bonus.id,

        'bonus_campaign_id',
        v_campaign.id,

        'bonus_campaign_code',
        v_campaign.code,

        'bonus_campaign_name',
        v_campaign.name,

        'conversion_type',
        v_campaign.conversion_type,

        'conversion_percentage',
        v_campaign.conversion_percentage,

        'conversion_amount',
        v_campaign.conversion_amount,

        'conversion_max_amount',
        v_campaign.conversion_max_amount,

        'conversion_base_amount',
        v_conversion_base,

        'conversion_amount_calculated',
        v_conversion_amount,

        'convertible_amount_before',
        v_bonus.convertible_amount,

        'converted_amount_before',
        v_bonus.converted_amount,

        'bonus_wallet_id',
        v_bonus_wallet_id,

        'main_wallet_id',
        v_main_wallet_id
    );


    ----------------------------------------------------------------
    -- 20. Create financial transaction
    ----------------------------------------------------------------
    SELECT
        r.transaction_id,
        r.created
    INTO
        v_transaction_id,
        v_transaction_created
    FROM public.create_financial_transaction(
        v_bonus.user_id,
        'bonus',
        'completed',
        v_campaign.game_system_id,
        'bonus_conversion',
        v_bonus.id::VARCHAR,
        v_idempotency_key,
        'Bonus conversion to Main wallet',
        v_metadata
    ) AS r;


    ----------------------------------------------------------------
    -- 21. If transaction already existed, return it
    ----------------------------------------------------------------
    IF NOT v_transaction_created THEN
        RETURN v_transaction_id;
    END IF;


    ----------------------------------------------------------------
    -- 22. Move actual money
    --
    -- Bonus wallet:
    --     - conversion amount
    --
    -- Main wallet:
    --     + conversion amount
    ----------------------------------------------------------------
    IF v_conversion_amount > 0 THEN

        UPDATE public.wallet_balances
        SET
            balance = balance - v_conversion_amount,
            updated_at = NOW()
        WHERE wallet_id = v_bonus_wallet_id;


        UPDATE public.wallet_balances
        SET
            balance = balance + v_conversion_amount,
            updated_at = NOW()
        WHERE wallet_id = v_main_wallet_id;


        ----------------------------------------------------------------
        -- 23. Bonus wallet debit ledger entry
        ----------------------------------------------------------------
        INSERT INTO public.ledger_entries (
            transaction_id,
            wallet_id,
            amount,
            created_at
        )
        VALUES (
            v_transaction_id,
            v_bonus_wallet_id,
            -v_conversion_amount,
            NOW()
        );


        ----------------------------------------------------------------
        -- 24. Main wallet credit ledger entry
        ----------------------------------------------------------------
        INSERT INTO public.ledger_entries (
            transaction_id,
            wallet_id,
            amount,
            created_at
        )
        VALUES (
            v_transaction_id,
            v_main_wallet_id,
            v_conversion_amount,
            NOW()
        );

    END IF;


    ----------------------------------------------------------------
    -- 25. Record converted amount
    ----------------------------------------------------------------
    UPDATE public.user_bonuses
    SET
        converted_amount = ROUND(
            COALESCE(converted_amount, 0)
            + v_conversion_amount,
            2
        ),
        updated_at = NOW()
    WHERE id = v_bonus.id;


    ----------------------------------------------------------------
    -- 26. Return financial transaction ID
    ----------------------------------------------------------------
    RETURN v_transaction_id;

END;
$$;


ALTER FUNCTION public.convert_bonus_to_main(p_user_bonus_id bigint) OWNER TO neondb_owner;

--
-- Name: create_bingo_game_from_selections(bigint, character varying, jsonb); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.create_bingo_game_from_selections(p_room_id bigint, p_stake_id character varying, p_selections jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
    ----------------------------------------------------------------
    -- Configuration
    ----------------------------------------------------------------
    v_room              public.bingo_rooms%ROWTYPE;
    v_stake             public.bingo_stakes%ROWTYPE;
    v_commission_rule   public.bingo_commission_rules%ROWTYPE;
    v_game_system       public.game_systems%ROWTYPE;

    ----------------------------------------------------------------
    -- Game
    ----------------------------------------------------------------
    v_game_id           INTEGER;
    v_game_code         VARCHAR(32);
    v_idempotency_key   VARCHAR(150);

    ----------------------------------------------------------------
    -- Game-code configuration
    ----------------------------------------------------------------
    v_code_prefix       VARCHAR(20);
    v_code_suffix       VARCHAR(20);
    v_code_type         VARCHAR(30);
    v_code_length       INTEGER;
    v_code_body         TEXT := '';
    v_code_seed         TEXT;
    v_code_char         TEXT;
    v_sequence_value    BIGINT;
    v_max_sequence      NUMERIC;

    ----------------------------------------------------------------
    -- Financials
    ----------------------------------------------------------------
    v_gross_pot         NUMERIC(18,2) := 0;
    v_commission_amount NUMERIC(18,2) := 0;
    v_prize_pool        NUMERIC(18,2) := 0;

    ----------------------------------------------------------------
    -- Selection processing
    ----------------------------------------------------------------
    v_selection         JSONB;
    v_user_id           INTEGER;
    v_card_id           INTEGER;
    v_card_data         JSONB;

    v_user              public.users%ROWTYPE;

    v_transaction_id    BIGINT;
    v_participant_id    BIGINT;

    v_user_card_count   INTEGER;
    v_total_cards       INTEGER := 0;
    v_total_participants INTEGER := 0;

    v_accepted          JSONB := '[]'::JSONB;
    v_rejected          JSONB := '[]'::JSONB;

    ----------------------------------------------------------------
    -- Transaction identity
    ----------------------------------------------------------------
    v_source_id         VARCHAR(100);
    v_card_idempotency_key VARCHAR(150);

    ----------------------------------------------------------------
    -- Time
    ----------------------------------------------------------------
    v_now               TIMESTAMPTZ := NOW();

    ----------------------------------------------------------------
    -- Existing game
    ----------------------------------------------------------------
    v_existing_game_id  INTEGER;

    ----------------------------------------------------------------
    -- Code generation
    ----------------------------------------------------------------
    v_code_attempt      INTEGER := 0;
    v_code_exists       BOOLEAN := FALSE;

BEGIN

    ----------------------------------------------------------------
    -- 1. Validate arguments
    ----------------------------------------------------------------

    IF p_room_id IS NULL OR p_room_id <= 0 THEN
        RAISE EXCEPTION
            'Invalid Bingo room ID';
    END IF;


    IF p_stake_id IS NULL
       OR BTRIM(p_stake_id) = '' THEN
        RAISE EXCEPTION
            'Bingo stake ID is required';
    END IF;


    IF p_selections IS NULL
       OR jsonb_typeof(p_selections) <> 'array' THEN
        RAISE EXCEPTION
            'Selections must be a JSON array';
    END IF;


    IF jsonb_array_length(p_selections) = 0 THEN
        RAISE EXCEPTION
            'At least one cartela selection is required';
    END IF;


    ----------------------------------------------------------------
    -- 2. Lock and validate room
    ----------------------------------------------------------------

    SELECT *
    INTO v_room
    FROM public.bingo_rooms
    WHERE id = p_room_id
    FOR UPDATE;


    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Bingo room % not found',
            p_room_id;
    END IF;


    IF v_room.status <> 'active' THEN
        RAISE EXCEPTION
            'Bingo room % is not active',
            p_room_id;
    END IF;


    ----------------------------------------------------------------
    -- 3. Validate room configuration
    ----------------------------------------------------------------

    IF v_room.card_count IS NULL
       OR v_room.card_count < 1 THEN
        RAISE EXCEPTION
            'Room % has invalid card_count configuration',
            v_room.id;
    END IF;


    IF v_room.max_cards_per_player IS NULL
       OR v_room.max_cards_per_player < 1 THEN
        RAISE EXCEPTION
            'Room % has invalid max_cards_per_player configuration',
            v_room.id;
    END IF;


    IF v_room.max_cards_per_player > v_room.card_count THEN
        RAISE EXCEPTION
            'Room % has max_cards_per_player (%) greater than card_count (%)',
            v_room.id,
            v_room.max_cards_per_player,
            v_room.card_count;
    END IF;


    ----------------------------------------------------------------
    -- 4. Validate stake
    ----------------------------------------------------------------

    SELECT *
    INTO v_stake
    FROM public.bingo_stakes
    WHERE id = p_stake_id
      AND is_active = TRUE;


    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Bingo stake "%" is not active or does not exist',
            p_stake_id;
    END IF;


    ----------------------------------------------------------------
    -- 5. Verify room allows this stake
    ----------------------------------------------------------------

    IF NOT EXISTS (
        SELECT 1
        FROM public.bingo_room_stakes
        WHERE room_id = v_room.id
          AND stake_id = v_stake.id
          AND status = 'active'
    ) THEN

        RAISE EXCEPTION
            'Stake "%" is not available in room %',
            v_stake.id,
            v_room.id;

    END IF;


    ----------------------------------------------------------------
    -- 6. Load the commission rule configured on the room
    --
    -- The current schema has:
    --
    -- bingo_rooms.commission_rule_id
    --
    -- Therefore we do NOT perform the old priority-based lookup.
    ----------------------------------------------------------------

    SELECT *
    INTO v_commission_rule
    FROM public.bingo_commission_rules
    WHERE id = v_room.commission_rule_id
    FOR UPDATE;


    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Commission rule % configured for room % was not found',
            v_room.commission_rule_id,
            v_room.id;
    END IF;


    ----------------------------------------------------------------
    -- 7. Validate commission rule
    ----------------------------------------------------------------

    IF NOT v_commission_rule.is_active THEN
        RAISE EXCEPTION
            'Commission rule % is not active',
            v_commission_rule.id;
    END IF;


    IF v_commission_rule.starts_at IS NOT NULL
       AND v_commission_rule.starts_at > v_now THEN

        RAISE EXCEPTION
            'Commission rule % has not started',
            v_commission_rule.id;

    END IF;


    IF v_commission_rule.ends_at IS NOT NULL
       AND v_commission_rule.ends_at < v_now THEN

        RAISE EXCEPTION
            'Commission rule % has expired',
            v_commission_rule.id;

    END IF;


    IF v_commission_rule.commission_rate < 0
       OR v_commission_rule.commission_rate > 100 THEN

        RAISE EXCEPTION
            'Commission rule % has invalid commission rate: %',
            v_commission_rule.id,
            v_commission_rule.commission_rate;

    END IF;


    ----------------------------------------------------------------
    -- 8. Validate commission rule / stake relationship
    --
    -- A room-level rule may have stake_id NULL.
    -- A stake-specific rule must match the requested stake.
    ----------------------------------------------------------------

    IF v_commission_rule.stake_id IS NOT NULL
       AND v_commission_rule.stake_id <> v_stake.id THEN

        RAISE EXCEPTION
            'Commission rule % is configured for stake %, but stake % was requested',
            v_commission_rule.id,
            v_commission_rule.stake_id,
            v_stake.id;

    END IF;


    ----------------------------------------------------------------
    -- 9. Load Bingo game system
    ----------------------------------------------------------------

    SELECT *
    INTO v_game_system
    FROM public.game_systems
    WHERE code = 'bingo'
      AND status = 'active'
    LIMIT 1;


    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Active Bingo game system was not found';
    END IF;


    ----------------------------------------------------------------
    -- 10. Validate game-code configuration
    ----------------------------------------------------------------

    v_code_prefix :=
        COALESCE(
            v_game_system.game_code_prefix,
            ''
        );


    v_code_suffix :=
        COALESCE(
            v_game_system.game_code_suffix,
            ''
        );


    v_code_type :=
        LOWER(
            BTRIM(
                COALESCE(
                    v_game_system.game_code_type,
                    ''
                )
            )
        );


    v_code_length :=
        v_game_system.game_code_length;


    IF v_code_type NOT IN (
        'sequential_numbers',
        'random_numbers',
        'random_alphabets',
        'sequential_alphabets',
        'alphanumeric',
        'random_alphanumeric'
    ) THEN

        RAISE EXCEPTION
            'Unsupported Bingo game code type: %',
            v_game_system.game_code_type;

    END IF;


    IF v_code_length IS NULL
       OR v_code_length <= 0 THEN

        RAISE EXCEPTION
            'Bingo game code length must be greater than zero';

    END IF;


    IF LENGTH(v_code_prefix)
       + v_code_length
       + LENGTH(v_code_suffix) > 32 THEN

        RAISE EXCEPTION
            'Bingo game code exceeds the maximum length of 32 characters. Prefix: %, body: %, suffix: %',
            LENGTH(v_code_prefix),
            v_code_length,
            LENGTH(v_code_suffix);

    END IF;


    ----------------------------------------------------------------
    -- 11. Generate game code
    --
    -- Sequential types lock the game_system row so that two
    -- concurrent game creations cannot receive the same sequence.
    ----------------------------------------------------------------

    IF v_code_type IN (
        'sequential_numbers',
        'sequential_alphabets'
    ) THEN

        SELECT *
        INTO v_game_system
        FROM public.game_systems
        WHERE id = v_game_system.id
        FOR UPDATE;


        v_sequence_value :=
            COALESCE(
                v_game_system.game_code_sequence,
                0
            );


        ----------------------------------------------------------------
        -- Sequential numbers
        --
        -- Example with length = 6:
        --
        -- 000001
        -- 000002
        -- 000003
        ----------------------------------------------------------------

        IF v_code_type = 'sequential_numbers' THEN

            v_sequence_value :=
                v_sequence_value + 1;


            v_max_sequence :=
                POWER(
                    10::NUMERIC,
                    v_code_length
                );


            IF v_sequence_value >= v_max_sequence THEN
                RAISE EXCEPTION
                    'Bingo sequential numeric game-code sequence has exceeded the configured length of %',
                    v_code_length;
            END IF;


            v_code_body :=
                LPAD(
                    v_sequence_value::TEXT,
                    v_code_length,
                    '0'
                );


        ----------------------------------------------------------------
        -- Sequential alphabets
        --
        -- Uses zero-based base-26.
        --
        -- length = 3:
        --
        -- AAA
        -- AAB
        -- AAC
        -- ...
        -- AAZ
        -- ABA
        ----------------------------------------------------------------

        ELSE

            v_max_sequence :=
                POWER(
                    26::NUMERIC,
                    v_code_length
                );


            IF v_sequence_value >= v_max_sequence THEN
                RAISE EXCEPTION
                    'Bingo sequential alphabet game-code sequence has exceeded the configured length of %',
                    v_code_length;
            END IF;


            v_code_body := '';


            FOR v_code_attempt IN 1..v_code_length
            LOOP

                v_code_body :=
                    CHR(
                        65
                        + (
                            v_sequence_value
                            % 26
                        )::INTEGER
                    )
                    || v_code_body;


                v_sequence_value :=
                    FLOOR(
                        v_sequence_value / 26
                    )::BIGINT;

            END LOOP;

        END IF;


        ----------------------------------------------------------------
        -- Persist next sequence value
        ----------------------------------------------------------------

        UPDATE public.game_systems
        SET
            game_code_sequence =
                CASE
                    WHEN v_code_type = 'sequential_numbers'
                    THEN
                        COALESCE(
                            game_code_sequence,
                            0
                        ) + 1

                    ELSE
                        COALESCE(
                            game_code_sequence,
                            0
                        ) + 1
                END,
            updated_at = NOW()
        WHERE id = v_game_system.id;


    ----------------------------------------------------------------
    -- Random code generation
    ----------------------------------------------------------------

    ELSE

        v_code_body := '';


        FOR v_code_attempt IN 1..v_code_length
        LOOP

            v_code_seed :=
                MD5(
                    v_room.id::TEXT
                    || ':'
                    || v_stake.id
                    || ':'
                    || v_now::TEXT
                    || ':'
                    || CLOCK_TIMESTAMP()::TEXT
                    || ':'
                    || RANDOM()::TEXT
                    || ':'
                    || v_code_attempt::TEXT
                );


            IF v_code_type = 'random_numbers' THEN

                v_code_char :=
                    SUBSTRING(
                        '0123456789'
                        FROM
                        (
                            (
                                GET_BYTE(
                                    DECODE(
                                        v_code_seed,
                                        'hex'
                                    ),
                                    (v_code_attempt - 1) % 16
                                )
                                % 10
                            ) + 1
                        )
                        FOR 1
                    );


            ELSIF v_code_type = 'random_alphabets' THEN

                v_code_char :=
                    SUBSTRING(
                        'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
                        FROM
                        (
                            (
                                GET_BYTE(
                                    DECODE(
                                        v_code_seed,
                                        'hex'
                                    ),
                                    (v_code_attempt - 1) % 16
                                )
                                % 26
                            ) + 1
                        )
                        FOR 1
                    );


            ELSE

                v_code_char :=
                    SUBSTRING(
                        'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
                        FROM
                        (
                            (
                                GET_BYTE(
                                    DECODE(
                                        v_code_seed,
                                        'hex'
                                    ),
                                    (v_code_attempt - 1) % 16
                                )
                                % 36
                            ) + 1
                        )
                        FOR 1
                    );

            END IF;


            v_code_body :=
                v_code_body
                || v_code_char;

        END LOOP;

    END IF;


    ----------------------------------------------------------------
    -- 12. Build final game code
    ----------------------------------------------------------------

    v_game_code :=
        v_code_prefix
        || v_code_body
        || v_code_suffix;


    v_game_code :=
        UPPER(
            v_game_code
        );


    ----------------------------------------------------------------
    -- 13. Check game-code collision
    ----------------------------------------------------------------

    SELECT EXISTS (
        SELECT 1
        FROM public.bingo_games
        WHERE game_code = v_game_code
    )
    INTO v_code_exists;


    IF v_code_exists THEN

        ----------------------------------------------------------------
        -- Sequential codes should never collide.
        ----------------------------------------------------------------

        IF v_code_type IN (
            'sequential_numbers',
            'sequential_alphabets'
        ) THEN

            RAISE EXCEPTION
                'Generated Bingo game code "%" already exists',
                v_game_code;

        END IF;


        ----------------------------------------------------------------
        -- Random codes:
        -- retry generation a few times.
        ----------------------------------------------------------------

        FOR v_code_attempt IN 1..10
        LOOP

            v_code_body := '';


            FOR v_user_card_count IN 1..v_code_length
            LOOP

                v_code_seed :=
                    MD5(
                        v_game_code
                        || ':'
                        || v_code_attempt::TEXT
                        || ':'
                        || v_user_card_count::TEXT
                        || ':'
                        || CLOCK_TIMESTAMP()::TEXT
                        || ':'
                        || RANDOM()::TEXT
                    );


                IF v_code_type = 'random_numbers' THEN

                    v_code_char :=
                        SUBSTRING(
                            '0123456789'
                            FROM
                            (
                                (
                                    GET_BYTE(
                                        DECODE(
                                            v_code_seed,
                                            'hex'
                                        ),
                                        (v_user_card_count - 1) % 16
                                    )
                                    % 10
                                ) + 1
                            )
                            FOR 1
                        );

                ELSIF v_code_type = 'random_alphabets' THEN

                    v_code_char :=
                        SUBSTRING(
                            'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
                            FROM
                            (
                                (
                                    GET_BYTE(
                                        DECODE(
                                            v_code_seed,
                                            'hex'
                                        ),
                                        (v_user_card_count - 1) % 16
                                    )
                                    % 26
                                ) + 1
                            )
                            FOR 1
                        );

                ELSE

                    v_code_char :=
                        SUBSTRING(
                            'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
                            FROM
                            (
                                (
                                    GET_BYTE(
                                        DECODE(
                                            v_code_seed,
                                            'hex'
                                        ),
                                        (v_user_card_count - 1) % 16
                                    )
                                    % 36
                                ) + 1
                            )
                            FOR 1
                        );

                END IF;


                v_code_body :=
                    v_code_body
                    || v_code_char;

            END LOOP;


            v_game_code :=
                UPPER(
                    v_code_prefix
                    || v_code_body
                    || v_code_suffix
                );


            SELECT EXISTS (
                SELECT 1
                FROM public.bingo_games
                WHERE game_code = v_game_code
            )
            INTO v_code_exists;


            EXIT WHEN NOT v_code_exists;

        END LOOP;


        IF v_code_exists THEN
            RAISE EXCEPTION
                'Unable to generate a unique Bingo game code after multiple attempts';
        END IF;

    END IF;


    ----------------------------------------------------------------
    -- 14. Generate internal game idempotency/transaction identity
    ----------------------------------------------------------------

    v_idempotency_key :=
        LEFT(
            'bingo-games:stake:'
            || v_stake.id
            || ':room:'
            || v_room.id
            || ':game:'
            || v_game_code,
            150
        );


    ----------------------------------------------------------------
    -- 15. Process every selected cartela
    ----------------------------------------------------------------

    FOR v_selection IN
        SELECT value
        FROM jsonb_array_elements(p_selections)
    LOOP

        ----------------------------------------------------------------
        -- Validate selection object
        ----------------------------------------------------------------

        IF jsonb_typeof(v_selection) <> 'object' THEN

            v_rejected :=
                v_rejected
                ||
                jsonb_build_array(
                    jsonb_build_object(
                        'selection',
                        v_selection,
                        'reason',
                        'invalid_selection'
                    )
                );

            CONTINUE;

        END IF;


        ----------------------------------------------------------------
        -- Extract selection values
        ----------------------------------------------------------------

        v_user_id :=
            NULLIF(
                v_selection->>'user_id',
                ''
            )::INTEGER;


        v_card_id :=
            NULLIF(
                v_selection->>'card_id',
                ''
            )::INTEGER;


        v_card_data :=
            COALESCE(
                v_selection->'card_data',
                '{}'::JSONB
            );


        ----------------------------------------------------------------
        -- Validate user ID
        ----------------------------------------------------------------

        IF v_user_id IS NULL OR v_user_id <= 0 THEN

            v_rejected :=
                v_rejected
                ||
                jsonb_build_array(
                    jsonb_build_object(
                        'user_id',
                        v_user_id,
                        'card_id',
                        v_card_id,
                        'reason',
                        'invalid_user_id'
                    )
                );

            CONTINUE;

        END IF;


        ----------------------------------------------------------------
        -- Validate card ID
        ----------------------------------------------------------------

        IF v_card_id IS NULL OR v_card_id < 1 THEN

            v_rejected :=
                v_rejected
                ||
                jsonb_build_array(
                    jsonb_build_object(
                        'user_id',
                        v_user_id,
                        'card_id',
                        v_card_id,
                        'reason',
                        'invalid_card_id'
                    )
                );

            CONTINUE;

        END IF;


        ----------------------------------------------------------------
        -- Card must belong to room's configured card pool
        ----------------------------------------------------------------

        IF v_card_id > v_room.card_count THEN

            v_rejected :=
                v_rejected
                ||
                jsonb_build_array(
                    jsonb_build_object(
                        'user_id',
                        v_user_id,
                        'card_id',
                        v_card_id,
                        'reason',
                        'card_out_of_range'
                    )
                );

            CONTINUE;

        END IF;


        ----------------------------------------------------------------
        -- Load and lock user
        ----------------------------------------------------------------

        SELECT *
        INTO v_user
        FROM public.users
        WHERE id = v_user_id
        FOR UPDATE;


        IF NOT FOUND THEN

            v_rejected :=
                v_rejected
                ||
                jsonb_build_array(
                    jsonb_build_object(
                        'user_id',
                        v_user_id,
                        'card_id',
                        v_card_id,
                        'reason',
                        'user_not_found'
                    )
                );

            CONTINUE;

        END IF;


        ----------------------------------------------------------------
        -- User status validation
        ----------------------------------------------------------------

        IF v_user.is_blocked THEN

            v_rejected :=
                v_rejected
                ||
                jsonb_build_array(
                    jsonb_build_object(
                        'user_id',
                        v_user_id,
                        'card_id',
                        v_card_id,
                        'reason',
                        'user_blocked'
                    )
                );

            CONTINUE;

        END IF;


        IF NOT v_user.is_active THEN

            v_rejected :=
                v_rejected
                ||
                jsonb_build_array(
                    jsonb_build_object(
                        'user_id',
                        v_user_id,
                        'card_id',
                        v_card_id,
                        'reason',
                        'user_inactive'
                    )
                );

            CONTINUE;

        END IF;

        ----------------------------------------------------------------
        -- Maximum cards per player
        --
        -- Derived exclusively from bingo_rooms.
        ----------------------------------------------------------------

        SELECT COUNT(*)
        INTO v_user_card_count
        FROM jsonb_array_elements(v_accepted) AS accepted
        WHERE
            (accepted->>'user_id')::INTEGER = v_user_id;


        IF v_user_card_count >= v_room.max_cards_per_player THEN

            v_rejected :=
                v_rejected
                ||
                jsonb_build_array(
                    jsonb_build_object(
                        'user_id',
                        v_user_id,
                        'card_id',
                        v_card_id,
                        'reason',
                        'max_cards_per_player_reached'
                    )
                );

            CONTINUE;

        END IF;


        ----------------------------------------------------------------
        -- Same card cannot be accepted twice
        ----------------------------------------------------------------

        IF EXISTS (
            SELECT 1
            FROM jsonb_array_elements(v_accepted) AS accepted
            WHERE
                (accepted->>'card_id')::INTEGER = v_card_id
        ) THEN

            v_rejected :=
                v_rejected
                ||
                jsonb_build_array(
                    jsonb_build_object(
                        'user_id',
                        v_user_id,
                        'card_id',
                        v_card_id,
                        'reason',
                        'card_already_selected'
                    )
                );

            CONTINUE;

        END IF;


        ----------------------------------------------------------------
        -- Financial transaction identity
        ----------------------------------------------------------------

        v_source_id :=
            LEFT(
                v_idempotency_key
                || ':'
                || v_user_id::TEXT
                || ':'
                || v_card_id::TEXT,
                100
            );


        v_card_idempotency_key :=
            LEFT(
                'bingo-card:'
                || v_idempotency_key
                || ':'
                || v_user_id::TEXT
                || ':'
                || v_card_id::TEXT,
                150
            );


        ----------------------------------------------------------------
        -- Charge stake
        --
        -- Each cartela gets its own savepoint.
        -- An insufficient balance only rejects that cartela.
        ----------------------------------------------------------------

        BEGIN

            v_transaction_id :=
                public.place_stake(
                    v_user_id,
                    v_stake.amount,
                    v_game_system.id,
                    'bingo_game_selection',
                    v_source_id,
                    v_card_idempotency_key,
                    'Bingo cartela stake',
                    jsonb_build_object(
                        'room_id',
                        v_room.id,

                        'stake_id',
                        v_stake.id,

                        'card_id',
                        v_card_id,

                        'user_id',
                        v_user_id,

                        'game_code',
                        v_game_code,

                        'game_system_id',
                        v_game_system.id
                    )
                );


        EXCEPTION
            WHEN OTHERS THEN

                IF SQLERRM LIKE 'Insufficient balance.%' THEN

                    v_rejected :=
                        v_rejected
                        ||
                        jsonb_build_array(
                            jsonb_build_object(
                                'user_id',
                                v_user_id,
                                'card_id',
                                v_card_id,
                                'reason',
                                'insufficient_balance'
                            )
                        );

                    CONTINUE;

                ELSE

                    RAISE;

                END IF;

        END;


        ----------------------------------------------------------------
        -- Successful selection
        ----------------------------------------------------------------

        v_accepted :=
            v_accepted
            ||
            jsonb_build_array(
                jsonb_build_object(
                    'user_id',
                    v_user_id,

                    'card_id',
                    v_card_id,

                    'card_data',
                    v_card_data,

                    'transaction_id',
                    v_transaction_id
                )
            );

    END LOOP;


    ----------------------------------------------------------------
    -- 16. Calculate final counts
    ----------------------------------------------------------------

    SELECT COUNT(*)
    INTO v_total_cards
    FROM jsonb_array_elements(v_accepted);


    SELECT COUNT(
        DISTINCT
        (value->>'user_id')::INTEGER
    )
    INTO v_total_participants
    FROM jsonb_array_elements(v_accepted);


    ----------------------------------------------------------------
    -- 17. Validate minimum players
    ----------------------------------------------------------------

    IF v_total_participants < v_room.min_players THEN

        RAISE EXCEPTION
            'Not enough eligible participants. Required: %, accepted: %',
            v_room.min_players,
            v_total_participants;

    END IF;


    ----------------------------------------------------------------
    -- 18. Validate maximum players
    ----------------------------------------------------------------

    IF v_room.max_players IS NOT NULL
       AND v_total_participants > v_room.max_players THEN

        RAISE EXCEPTION
            'Too many participants. Maximum: %, accepted: %',
            v_room.max_players,
            v_total_participants;

    END IF;


    ----------------------------------------------------------------
    -- 19. There must be at least one accepted card
    ----------------------------------------------------------------

    IF v_total_cards <= 0 THEN

        RAISE EXCEPTION
            'No eligible cartela selections were accepted';

    END IF;


    ----------------------------------------------------------------
    -- 20. Calculate financial totals
    ----------------------------------------------------------------

    v_gross_pot :=
        ROUND(
            v_total_cards
            * v_stake.amount,
            2
        );


    v_commission_amount :=
        ROUND(
            v_gross_pot
            * v_commission_rule.commission_rate
            / 100,
            2
        );


    v_prize_pool :=
        ROUND(
            v_gross_pot
            - v_commission_amount,
            2
        );


    ----------------------------------------------------------------
    -- 21. Create Bingo game
    ----------------------------------------------------------------

    INSERT INTO public.bingo_games (
        game_code,
        room_id,
        stake_id,
        stake_amount,
        commission_rule_id,
        commission_rate,
        gross_pot,
        commission_amount,
        prize_pool,
        status,
        is_split,
        selection_started_at,
        selection_ends_at,
        card_count,
        max_cards_per_player,
        idempotency_key,
        created_at
    )
    VALUES (
        v_game_code,
        v_room.id,
        v_stake.id,
        v_stake.amount,
        v_commission_rule.id,
        v_commission_rule.commission_rate,
        v_gross_pot,
        v_commission_amount,
        v_prize_pool,
        'selection',
        FALSE,
        v_now,
        v_now
            + MAKE_INTERVAL(
                secs => v_room.selection_seconds
            ),
        v_room.card_count,
        v_room.max_cards_per_player,
        v_idempotency_key,
        v_now
    )
    RETURNING id
    INTO v_game_id;


    ----------------------------------------------------------------
    -- 22. Create participants
    ----------------------------------------------------------------

    INSERT INTO public.bingo_participants (
        game_id,
        user_id,
        amount_paid,
        status,
        is_disqualified,
        amount_won,
        joined_at
    )
    SELECT
        v_game_id,
        accepted.user_id,
        COUNT(*) * v_stake.amount,
        'active',
        FALSE,
        0,
        v_now
    FROM (
        SELECT
            (value->>'user_id')::INTEGER AS user_id
        FROM jsonb_array_elements(v_accepted)
    ) AS accepted
    GROUP BY
        accepted.user_id;


    ----------------------------------------------------------------
    -- 23. Create participant cards
    ----------------------------------------------------------------

    INSERT INTO public.bingo_participant_cards (
        participant_id,
        game_id,
        card_id,
        card_data,
        transaction_id,
        created_at
    )
    SELECT
        bp.id,
        v_game_id,
        (accepted.value->>'card_id')::INTEGER,
        COALESCE(
            accepted.value->'card_data',
            '{}'::JSONB
        ),
        (accepted.value->>'transaction_id')::BIGINT,
        v_now
    FROM jsonb_array_elements(v_accepted) AS accepted
    JOIN public.bingo_participants bp
      ON bp.game_id = v_game_id
     AND bp.user_id =
         (accepted.value->>'user_id')::INTEGER;


    ----------------------------------------------------------------
    -- 24. Final result
    ----------------------------------------------------------------

    RETURN jsonb_build_object(

        'success',
        TRUE,

        'idempotent',
        FALSE,

        'game_id',
        v_game_id,

        'game_code',
        v_game_code,

        'idempotency_key',
        v_idempotency_key,

        'game_system_id',
        v_game_system.id,

        'game_code_type',
        v_code_type,

        'game_code_prefix',
        v_code_prefix,

        'game_code_suffix',
        v_code_suffix,

        'game_code_length',
        v_code_length,

        'room_id',
        v_room.id,

        'stake_id',
        v_stake.id,

        'stake_amount',
        v_stake.amount,

        'card_count',
        v_room.card_count,

        'max_cards_per_player',
        v_room.max_cards_per_player,

        'total_participants',
        v_total_participants,

        'total_cards',
        v_total_cards,

        'gross_pot',
        v_gross_pot,

        'commission_rule_id',
        v_commission_rule.id,

        'commission_rate',
        v_commission_rule.commission_rate,

        'commission_amount',
        v_commission_amount,

        'prize_pool',
        v_prize_pool,

        'selection_started_at',
        v_now,

        'selection_ends_at',
        v_now
            + MAKE_INTERVAL(
                secs => v_room.selection_seconds
            ),

        'accepted',
        v_accepted,

        'rejected',
        v_rejected

    );

END;
$$;


ALTER FUNCTION public.create_bingo_game_from_selections(p_room_id bigint, p_stake_id character varying, p_selections jsonb) OWNER TO neondb_owner;

--
-- Name: create_financial_transaction(integer, character varying, character varying, bigint, character varying, character varying, character varying, text, jsonb); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.create_financial_transaction(p_user_id integer, p_type character varying, p_status character varying DEFAULT 'completed'::character varying, p_game_system_id bigint DEFAULT NULL::bigint, p_source_type character varying DEFAULT NULL::character varying, p_source_id character varying DEFAULT NULL::character varying, p_idempotency_key character varying DEFAULT NULL::character varying, p_description text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb) RETURNS TABLE(transaction_id bigint, created boolean)
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_existing financial_transactions%ROWTYPE;
BEGIN
    /*
     * Basic validation
     */
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'Financial transaction user_id is required';
    END IF;

    IF p_type IS NULL OR BTRIM(p_type) = '' THEN
        RAISE EXCEPTION 'Financial transaction type is required';
    END IF;

    IF p_status IS NULL OR BTRIM(p_status) = '' THEN
        RAISE EXCEPTION 'Financial transaction status is required';
    END IF;


    /*
     * No idempotency key:
     * Always create a new transaction.
     */
    IF p_idempotency_key IS NULL THEN

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
            NULL,
            p_description,
            COALESCE(p_metadata, '{}'::jsonb),
            NOW(),
            CASE
                WHEN p_status = 'completed'
                THEN NOW()
                ELSE NULL
            END
        )
        RETURNING id
        INTO transaction_id;

        created := TRUE;

        RETURN NEXT;
        RETURN;
    END IF;


    /*
     * Idempotent creation.
     *
     * The unique partial index on idempotency_key guarantees
     * that only one transaction can win the insert race.
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
    DO NOTHING
    RETURNING id
    INTO transaction_id;


    /*
     * Insert succeeded.
     */
    IF FOUND THEN
        created := TRUE;

        RETURN NEXT;
        RETURN;
    END IF;


    /*
     * Transaction already exists for this idempotency key.
     *
     * Lock the existing transaction before validating it.
     */
    SELECT ft.*
    INTO v_existing
    FROM financial_transactions AS ft
    WHERE ft.idempotency_key = p_idempotency_key
    FOR UPDATE;


    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Idempotency conflict occurred but existing transaction was not found for key: %',
            p_idempotency_key;
    END IF;


    /*
     * An idempotency key must represent exactly one logical
     * financial operation.
     *
     * Reusing the same key with different parameters is an error.
     */
    IF v_existing.user_id IS DISTINCT FROM p_user_id
       OR v_existing.type IS DISTINCT FROM p_type
       OR v_existing.status IS DISTINCT FROM p_status
       OR v_existing.game_system_id IS DISTINCT FROM p_game_system_id
       OR v_existing.source_type IS DISTINCT FROM p_source_type
       OR v_existing.source_id IS DISTINCT FROM p_source_id
    THEN
        RAISE EXCEPTION
            'Idempotency key "%" already belongs to a different financial transaction',
            p_idempotency_key;
    END IF;


    /*
     * Existing transaction is the result of this idempotent
     * operation.
     */
    transaction_id := v_existing.id;
    created := FALSE;

    RETURN NEXT;
    RETURN;
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
    main_wallet_id  BIGINT;
    play_wallet_id  BIGINT;
    bonus_wallet_id BIGINT;
BEGIN

    ----------------------------------------------------------------
    -- MAIN WALLET
    ----------------------------------------------------------------
    INSERT INTO public.wallets (
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
        SET
            is_active = TRUE,
            updated_at = NOW()
    RETURNING id
    INTO main_wallet_id;


    ----------------------------------------------------------------
    -- PLAY WALLET
    ----------------------------------------------------------------
    INSERT INTO public.wallets (
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
        SET
            is_active = TRUE,
            updated_at = NOW()
    RETURNING id
    INTO play_wallet_id;


    ----------------------------------------------------------------
    -- BONUS WALLET
    --
    -- Used exclusively for promotional bonus funds.
    ----------------------------------------------------------------
    INSERT INTO public.wallets (
        user_id,
        wallet_type,
        currency,
        is_active
    )
    VALUES (
        NEW.id,
        'bonus',
        'ETB',
        TRUE
    )
    ON CONFLICT (user_id, wallet_type)
    DO UPDATE
        SET
            is_active = TRUE,
            updated_at = NOW()
    RETURNING id
    INTO bonus_wallet_id;


    ----------------------------------------------------------------
    -- MAIN BALANCE
    ----------------------------------------------------------------
    INSERT INTO public.wallet_balances (
        wallet_id,
        balance
    )
    VALUES (
        main_wallet_id,
        0
    )
    ON CONFLICT (wallet_id)
    DO NOTHING;


    ----------------------------------------------------------------
    -- PLAY BALANCE
    ----------------------------------------------------------------
    INSERT INTO public.wallet_balances (
        wallet_id,
        balance
    )
    VALUES (
        play_wallet_id,
        0
    )
    ON CONFLICT (wallet_id)
    DO NOTHING;


    ----------------------------------------------------------------
    -- BONUS BALANCE
    ----------------------------------------------------------------
    INSERT INTO public.wallet_balances (
        wallet_id,
        balance
    )
    VALUES (
        bonus_wallet_id,
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
    v_transaction_created BOOLEAN;

    v_amount NUMERIC(18,2);
BEGIN

    -- --------------------------------------------------------
    -- Validate amount
    -- --------------------------------------------------------

    v_amount := ROUND(p_amount, 2);

    IF v_amount <= 0 THEN
        RAISE EXCEPTION
            'Deposit amount must be greater than zero';
    END IF;


    -- --------------------------------------------------------
    -- Get Play wallet
    -- --------------------------------------------------------

    v_wallet_id :=
        get_user_wallet_id(
            p_user_id,
            'play'
        );


    -- --------------------------------------------------------
    -- Lock wallet
    -- --------------------------------------------------------

    PERFORM lock_wallet(v_wallet_id);


    -- --------------------------------------------------------
    -- Create / retrieve financial transaction atomically
    -- --------------------------------------------------------

    SELECT
        t.transaction_id,
        t.created
    INTO
        v_transaction_id,
        v_transaction_created
    FROM create_financial_transaction(
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
    ) AS t;


    -- --------------------------------------------------------
    -- Existing idempotent transaction.
    --
    -- CRITICAL:
    -- Do NOT insert another ledger entry.
    -- Do NOT update wallet balance.
    -- --------------------------------------------------------

    IF NOT v_transaction_created THEN
        RETURN v_transaction_id;
    END IF;


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
        v_wallet_id,
        v_amount
    );


    -- --------------------------------------------------------
    -- Balance
    -- --------------------------------------------------------

    UPDATE wallet_balances
    SET
        balance = balance + v_amount,
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
    v_game public.bingo_games%ROWTYPE;

    v_game_system_id bigint;

    v_winner_count integer;

    v_prize_pool numeric(18,2);
    v_base_payout numeric(18,2);
    v_remainder_cents integer;

    v_total_payout numeric(18,2) := 0;

    v_winner record;

    v_transaction_id bigint;

    v_winner_details jsonb := '[]'::jsonb;

BEGIN

    ----------------------------------------------------------------
    -- 1. Validate arguments
    ----------------------------------------------------------------

    IF p_game_id IS NULL OR p_game_id <= 0 THEN
        RAISE EXCEPTION
            'Invalid game ID: %',
            p_game_id;
    END IF;


    IF p_winner_card_ids IS NULL
       OR cardinality(p_winner_card_ids) = 0 THEN

        RAISE EXCEPTION
            'At least one winning card is required';

    END IF;


    ----------------------------------------------------------------
    -- 2. Remove duplicate card IDs
    --
    -- If the caller accidentally sends:
    --
    -- [101, 102, 102, 103]
    --
    -- it becomes:
    --
    -- [101, 102, 103]
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
    --
    -- This is extremely important.
    --
    -- Two requests cannot settle the same game simultaneously.
    ----------------------------------------------------------------

    SELECT *
    INTO v_game
    FROM public.bingo_games
    WHERE id = p_game_id
    FOR UPDATE;


    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Bingo game % does not exist',
            p_game_id;
    END IF;


    ----------------------------------------------------------------
    -- 4. Make sure the game has not already been settled
    ----------------------------------------------------------------

    IF v_game.status = 'completed' THEN
        RAISE EXCEPTION
            'Bingo game % is already completed',
            p_game_id;
    END IF;


    IF v_game.status = 'cancelled' THEN
        RAISE EXCEPTION
            'Bingo game % is cancelled',
            p_game_id;
    END IF;


    ----------------------------------------------------------------
    -- 5. Get the Bingo game system
    ----------------------------------------------------------------

    SELECT gs.id
    INTO v_game_system_id
    FROM public.game_systems gs
    WHERE gs.code = 'bingo'
      AND gs.status = 'active'
    LIMIT 1;


    IF v_game_system_id IS NULL THEN
        RAISE EXCEPTION
            'Active Bingo game system was not found';
    END IF;


    ----------------------------------------------------------------
    -- 6. Make sure every winning card belongs to this game
    ----------------------------------------------------------------

    IF EXISTS (
        SELECT 1
        FROM unnest(p_winner_card_ids) AS x(card_id)

        LEFT JOIN public.bingo_participant_cards bpc
            ON bpc.card_id = x.card_id
           AND bpc.game_id = p_game_id

        WHERE bpc.card_id IS NULL
    ) THEN

        RAISE EXCEPTION
            'One or more winning cards do not belong to game %',
            p_game_id;

    END IF;


    ----------------------------------------------------------------
    -- 7. Make sure every winning card belongs to a valid participant
    ----------------------------------------------------------------

    IF EXISTS (
        SELECT 1

        FROM public.bingo_participant_cards bpc

        INNER JOIN public.bingo_participants bp
            ON bp.id = bpc.participant_id
           AND bp.game_id = p_game_id

        WHERE bpc.game_id = p_game_id
          AND bpc.card_id = ANY(p_winner_card_ids)

          AND (
              bp.status <> 'active'
              OR bp.is_disqualified = TRUE
          )
    ) THEN

        RAISE EXCEPTION
            'One or more winning cards belong to an invalid/disqualified participant';

    END IF;


    ----------------------------------------------------------------
    -- 8. Make sure none of the cards has already been paid
    ----------------------------------------------------------------

    IF EXISTS (
        SELECT 1
        FROM public.bingo_winners bw
        WHERE bw.game_id = p_game_id
          AND bw.card_id = ANY(p_winner_card_ids)
    ) THEN

        RAISE EXCEPTION
            'One or more winning cards have already been settled for game %',
            p_game_id;

    END IF;


    ----------------------------------------------------------------
    -- 9. Lock all winning cards
    ----------------------------------------------------------------

    PERFORM 1
    FROM public.bingo_participant_cards bpc
    WHERE bpc.game_id = p_game_id
      AND bpc.card_id = ANY(p_winner_card_ids)
    FOR UPDATE;


    ----------------------------------------------------------------
    -- 10. Lock their participants
    ----------------------------------------------------------------

    PERFORM 1
    FROM public.bingo_participants bp
    WHERE bp.game_id = p_game_id
      AND bp.id IN (
          SELECT bpc.participant_id
          FROM public.bingo_participant_cards bpc
          WHERE bpc.game_id = p_game_id
            AND bpc.card_id = ANY(p_winner_card_ids)
      )
    FOR UPDATE;


    ----------------------------------------------------------------
    -- 11. Use the prize pool calculated when the game was created
    --
    -- DO NOT use gross_pot here.
    --
    -- create_bingo_game_from_selections() already calculated:
    --
    -- gross_pot
    -- commission_amount
    -- prize_pool
    --
    -- Winners receive prize_pool.
    ----------------------------------------------------------------

    v_prize_pool :=
        ROUND(
            COALESCE(v_game.prize_pool, 0),
            2
        );


    IF v_prize_pool <= 0 THEN
        RAISE EXCEPTION
            'Game % has no prize pool',
            p_game_id;
    END IF;


    ----------------------------------------------------------------
    -- 12. Count winning cards
    --
    -- IMPORTANT:
    --
    -- This is the number of WINNING CARDS,
    -- not the number of winning USERS.
    --
    -- One user may therefore appear multiple times.
    ----------------------------------------------------------------

    v_winner_count :=
        cardinality(p_winner_card_ids);


    ----------------------------------------------------------------
    -- 13. Calculate payout per card
    --
    -- We work in cents to guarantee:
    --
    -- SUM(all payouts) = prize_pool
    --
    -- Example:
    --
    -- prize_pool = 100
    -- winners    = 3
    --
    -- payouts:
    -- 33.34
    -- 33.33
    -- 33.33
    ----------------------------------------------------------------

    v_base_payout :=
        FLOOR(
            (v_prize_pool * 100)
            / v_winner_count
        ) / 100;


    v_remainder_cents :=
        ROUND(v_prize_pool * 100)
        -
        (
            ROUND(v_base_payout * 100)
            * v_winner_count
        );


    ----------------------------------------------------------------
    -- 14. Settle every winning card
    ----------------------------------------------------------------

    FOR v_winner IN

        SELECT
            bpc.id AS participant_card_id,

            bpc.card_id,

            bpc.participant_id,

            bp.user_id,

            (
                v_base_payout

                +

                CASE
                    WHEN ROW_NUMBER() OVER (
                        ORDER BY bpc.card_id
                    ) <= v_remainder_cents
                    THEN 0.01
                    ELSE 0
                END

            )::numeric(18,2) AS payout

        FROM public.bingo_participant_cards bpc

        INNER JOIN public.bingo_participants bp
            ON bp.id = bpc.participant_id
           AND bp.game_id = p_game_id

        WHERE bpc.game_id = p_game_id
          AND bpc.card_id = ANY(p_winner_card_ids)

        ORDER BY bpc.card_id

    LOOP


        ----------------------------------------------------------------
        -- 14a. Credit the winner
        --
        -- This should be the existing financial function responsible
        -- for creating the winning transaction and crediting the
        -- user's main wallet.
        ----------------------------------------------------------------

        v_transaction_id :=
            public.record_game_win(
                p_user_id        => v_winner.user_id,

                p_amount         => v_winner.payout,

                p_game_system_id => v_game_system_id,

                p_source_type    => 'bingo_game',

                p_source_id      => p_game_id::text,

                p_idempotency_key =>
                    'bingo:game:'
                    || p_game_id
                    || ':card:'
                    || v_winner.card_id,

                p_description =>
                    'Bingo winning payout - game #'
                    || p_game_id
                    || ', card #'
                    || v_winner.card_id,

                p_metadata =>
                    jsonb_build_object(
                        'game_id',
                        p_game_id,

                        'card_id',
                        v_winner.card_id,

                        'participant_id',
                        v_winner.participant_id,

                        'participant_card_id',
                        v_winner.participant_card_id,

                        'stake_id',
                        v_game.stake_id,

                        'stake_amount',
                        v_game.stake_amount,

                        'gross_pot',
                        v_game.gross_pot,

                        'commission_amount',
                        v_game.commission_amount,

                        'prize_pool',
                        v_game.prize_pool
                    )
            );


        ----------------------------------------------------------------
        -- 14b. Record the winning card
        ----------------------------------------------------------------

        INSERT INTO public.bingo_winners (
            game_id,
            participant_id,
            user_id,
            card_id,
            payout,
            transaction_id
        )
        VALUES (
            p_game_id,
            v_winner.participant_id,
            v_winner.user_id,
            v_winner.card_id,
            v_winner.payout,
            v_transaction_id
        );


        ----------------------------------------------------------------
        -- 14c. Accumulate total payout
        ----------------------------------------------------------------

        v_total_payout :=
            ROUND(
                v_total_payout + v_winner.payout,
                2
            );


        ----------------------------------------------------------------
        -- 14d. Add result to returned JSON
        ----------------------------------------------------------------

        v_winner_details :=
            v_winner_details
            ||
            jsonb_build_array(
                jsonb_build_object(
                    'card_id',
                    v_winner.card_id,

                    'participant_id',
                    v_winner.participant_id,

                    'user_id',
                    v_winner.user_id,

                    'payout',
                    v_winner.payout,

                    'transaction_id',
                    v_transaction_id
                )
            );

    END LOOP;


    ----------------------------------------------------------------
    -- 15. Final accounting safety check
    ----------------------------------------------------------------

    IF ROUND(v_total_payout, 2)
       <> ROUND(v_prize_pool, 2) THEN

        RAISE EXCEPTION
            'Payout mismatch for game %. Prize pool: %, total payout: %',
            p_game_id,
            v_prize_pool,
            v_total_payout;

    END IF;


    ----------------------------------------------------------------
    -- 16. Mark participants as completed
    --
    -- This does NOT modify users.
    ----------------------------------------------------------------

    UPDATE public.bingo_participants
    SET status = 'completed'
    WHERE game_id = p_game_id;


    ----------------------------------------------------------------
    -- 17. Complete the Bingo game
    ----------------------------------------------------------------

    UPDATE public.bingo_games
    SET
        status = 'completed',

        is_split =
            v_winner_count > 1,

        ended_at = NOW()

    WHERE id = p_game_id;


    ----------------------------------------------------------------
    -- 18. Return settlement information
    ----------------------------------------------------------------

    RETURN jsonb_build_object(

        'success',
        TRUE,

        'game_id',
        p_game_id,

        'status',
        'completed',

        'stake_id',
        v_game.stake_id,

        'stake_amount',
        v_game.stake_amount,

        'gross_pot',
        v_game.gross_pot,

        'commission_amount',
        v_game.commission_amount,

        'prize_pool',
        v_prize_pool,

        'winning_card_count',
        v_winner_count,

        'total_payout',
        v_total_payout,

        'winner_details',
        v_winner_details

    );

END;
$$;


ALTER FUNCTION public.end_bingo_game(p_game_id integer, p_winner_card_ids integer[]) OWNER TO neondb_owner;

--
-- Name: end_bingo_game(integer, bigint[]); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.end_bingo_game(p_game_id integer, p_winner_card_ids bigint[]) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_game                    public.bingo_games%ROWTYPE;
    v_disqualification_policy varchar(30);
    v_game_system_id          bigint;

    v_candidate_card_ids      bigint[];
    v_eligible_card_ids       bigint[];

    v_winner_count            integer;

    v_prize_pool_cents        bigint;
    v_base_payout_cents       bigint;
    v_remainder_cents         bigint;

    v_index                   integer;
    v_payout_cents            bigint;
    v_payout                  numeric;

    v_card                    RECORD;
    v_transaction_id          bigint;

    v_total_paid              numeric := 0;
    v_result_winners          jsonb := '[]'::jsonb;
BEGIN

    ----------------------------------------------------------------------
    -- Validate arguments
    ----------------------------------------------------------------------

    IF p_game_id IS NULL THEN
        RAISE EXCEPTION 'Game ID is required';
    END IF;

    IF p_winner_card_ids IS NULL
       OR cardinality(p_winner_card_ids) = 0 THEN
        RAISE EXCEPTION 'At least one winning card is required';
    END IF;


    ----------------------------------------------------------------------
    -- Get Bingo game system
    ----------------------------------------------------------------------

    SELECT gs.id
    INTO v_game_system_id
    FROM public.game_systems gs
    WHERE gs.code = 'bingo'
      AND gs.status = 'active'
    LIMIT 1;

    IF v_game_system_id IS NULL THEN
        RAISE EXCEPTION
            'Active Bingo game system was not found';
    END IF;


    ----------------------------------------------------------------------
    -- Deduplicate candidate participant-card IDs
    ----------------------------------------------------------------------

    SELECT ARRAY_AGG(card_id ORDER BY card_id)
    INTO v_candidate_card_ids
    FROM (
        SELECT DISTINCT card_id
        FROM unnest(p_winner_card_ids) AS card_id
    ) x;


    ----------------------------------------------------------------------
    -- Lock the game
    ----------------------------------------------------------------------

    SELECT *
    INTO v_game
    FROM public.bingo_games
    WHERE id = p_game_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Bingo game % not found',
            p_game_id;
    END IF;


    ----------------------------------------------------------------------
    -- Validate game state
    ----------------------------------------------------------------------

    IF v_game.status = 'completed' THEN
        RAISE EXCEPTION
            'Bingo game % is already completed',
            p_game_id;
    END IF;

    IF v_game.status = 'cancelled' THEN
        RAISE EXCEPTION
            'Bingo game % is cancelled',
            p_game_id;
    END IF;


    ----------------------------------------------------------------------
    -- Get room disqualification policy
    ----------------------------------------------------------------------

    SELECT br.disqualification_policy
    INTO v_disqualification_policy
    FROM public.bingo_rooms br
    WHERE br.id = v_game.room_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Room % for game % was not found',
            v_game.room_id,
            p_game_id;
    END IF;


    ----------------------------------------------------------------------
    -- Validate disqualification policy
    ----------------------------------------------------------------------

    IF v_disqualification_policy NOT IN (
        'exclude_card',
        'exclude_participant',
        'include'
    ) THEN
        RAISE EXCEPTION
            'Invalid disqualification policy: %',
            v_disqualification_policy;
    END IF;


    ----------------------------------------------------------------------
    -- Validate prize pool
    ----------------------------------------------------------------------

    IF COALESCE(v_game.prize_pool, 0) <= 0 THEN
        RAISE EXCEPTION
            'Bingo game % has no prize pool',
            p_game_id;
    END IF;


    ----------------------------------------------------------------------
    -- Validate that every supplied participant-card belongs to this game
    ----------------------------------------------------------------------

    IF EXISTS (
        SELECT 1
        FROM unnest(v_candidate_card_ids) AS submitted_card_id
        WHERE NOT EXISTS (
            SELECT 1
            FROM public.bingo_participant_cards pc
            WHERE pc.id = submitted_card_id
              AND pc.game_id = p_game_id
        )
    ) THEN
        RAISE EXCEPTION
            'One or more winning cards do not belong to game %',
            p_game_id;
    END IF;


    ----------------------------------------------------------------------
    -- Lock candidate cards and their participants
    ----------------------------------------------------------------------

    PERFORM 1
    FROM public.bingo_participant_cards pc
    JOIN public.bingo_participants bp
      ON bp.id = pc.participant_id
    WHERE pc.id = ANY(v_candidate_card_ids)
    ORDER BY pc.id
    FOR UPDATE OF pc, bp;


    ----------------------------------------------------------------------
    -- Determine eligible winning cards according to room policy
    ----------------------------------------------------------------------

    SELECT ARRAY_AGG(pc.id ORDER BY pc.id)
    INTO v_eligible_card_ids
    FROM public.bingo_participant_cards pc
    JOIN public.bingo_participants bp
      ON bp.id = pc.participant_id
    WHERE pc.id = ANY(v_candidate_card_ids)
      AND
      (
          ----------------------------------------------------------------
          -- Ignore disqualification entirely
          ----------------------------------------------------------------
          v_disqualification_policy = 'include'

          OR

          ----------------------------------------------------------------
          -- Exclude only the specific disqualified card
          ----------------------------------------------------------------
          (
              v_disqualification_policy = 'exclude_card'
              AND bp.status = 'active'
              AND pc.is_disqualified = FALSE
          )

          OR

          ----------------------------------------------------------------
          -- Exclude every card belonging to a disqualified participant
          ----------------------------------------------------------------
          (
              v_disqualification_policy = 'exclude_participant'
              AND bp.status = 'active'
              AND bp.is_disqualified = FALSE
          )
      );


    ----------------------------------------------------------------------
    -- No eligible winners
    ----------------------------------------------------------------------

    IF v_eligible_card_ids IS NULL
       OR cardinality(v_eligible_card_ids) = 0 THEN
        RAISE EXCEPTION
            'No eligible winning cards remain after applying disqualification policy "%"',
            v_disqualification_policy;
    END IF;


    ----------------------------------------------------------------------
    -- Prevent previously settled winning cards
    ----------------------------------------------------------------------

    IF EXISTS (
        SELECT 1
        FROM public.bingo_participant_cards pc
        JOIN public.bingo_winners bw
          ON bw.game_id = p_game_id
         AND bw.card_id = pc.card_id
        WHERE pc.id = ANY(v_eligible_card_ids)
    ) THEN
        RAISE EXCEPTION
            'One or more winning cards have already been settled for game %',
            p_game_id;
    END IF;


    ----------------------------------------------------------------------
    -- Number of winning cards
    ----------------------------------------------------------------------

    v_winner_count :=
        cardinality(v_eligible_card_ids);


    ----------------------------------------------------------------------
    -- Convert prize pool to cents
    ----------------------------------------------------------------------

    v_prize_pool_cents :=
        ROUND(v_game.prize_pool * 100)::bigint;

    v_base_payout_cents :=
        v_prize_pool_cents / v_winner_count;

    v_remainder_cents :=
        v_prize_pool_cents % v_winner_count;


    ----------------------------------------------------------------------
    -- Pay every eligible winning card
    ----------------------------------------------------------------------

    v_index := 0;

    FOR v_card IN
        SELECT
            pc.id AS participant_card_id,
            pc.card_id,
            pc.participant_id,
            bp.user_id
        FROM public.bingo_participant_cards pc
        JOIN public.bingo_participants bp
          ON bp.id = pc.participant_id
        WHERE pc.id = ANY(v_eligible_card_ids)
        ORDER BY pc.id
    LOOP

        v_index := v_index + 1;


        ------------------------------------------------------------------
        -- Equal payout per winning card.
        -- Remainder cents are distributed one-by-one.
        ------------------------------------------------------------------

        v_payout_cents :=
            v_base_payout_cents
            +
            CASE
                WHEN v_index <= v_remainder_cents THEN 1
                ELSE 0
            END;

        v_payout :=
            v_payout_cents / 100.0;


        ------------------------------------------------------------------
        -- Record financial win
        ------------------------------------------------------------------

        v_transaction_id :=
            public.record_game_win(
                v_card.user_id,
                v_payout,
                v_game_system_id,
                'bingo_game',
                v_game.id::text,

                format(
                    'bingo-win:%s:participant-card:%s',
                    v_game.id,
                    v_card.participant_card_id
                ),

                format(
                    'Bingo win for game %s, card %s',
                    v_game.game_code,
                    v_card.card_id
                ),

                jsonb_build_object(
                    'game_id', v_game.id,
                    'game_code', v_game.game_code,
                    'room_id', v_game.room_id,
                    'participant_id', v_card.participant_id,
                    'participant_card_id', v_card.participant_card_id,
                    'card_id', v_card.card_id,
                    'payout', v_payout,
                    'disqualification_policy',
                        v_disqualification_policy
                )
            );


        ------------------------------------------------------------------
        -- Record winning card
        ------------------------------------------------------------------

        INSERT INTO public.bingo_winners (
            game_id,
            participant_id,
            user_id,
            card_id,
            payout,
            transaction_id
        )
        VALUES (
            v_game.id,
            v_card.participant_id,
            v_card.user_id,
            v_card.card_id,
            v_payout,
            v_transaction_id
        );


        ------------------------------------------------------------------
        -- Maintain participant settlement total
        ------------------------------------------------------------------

        UPDATE public.bingo_participants
        SET amount_won =
            COALESCE(amount_won, 0) + v_payout
        WHERE id = v_card.participant_id;


        ------------------------------------------------------------------
        -- Add winner to result
        ------------------------------------------------------------------

        v_result_winners :=
            v_result_winners ||
            jsonb_build_array(
                jsonb_build_object(
                    'participant_card_id',
                    v_card.participant_card_id,

                    'card_id',
                    v_card.card_id,

                    'participant_id',
                    v_card.participant_id,

                    'user_id',
                    v_card.user_id,

                    'payout',
                    v_payout,

                    'transaction_id',
                    v_transaction_id
                )
            );


        v_total_paid :=
            v_total_paid + v_payout;

    END LOOP;


    ----------------------------------------------------------------------
    -- Accounting safety check
    ----------------------------------------------------------------------

    IF ROUND(v_total_paid * 100)::bigint <> v_prize_pool_cents THEN
        RAISE EXCEPTION
            'Settlement mismatch for game %. Prize pool: %, total paid: %',
            p_game_id,
            v_game.prize_pool,
            v_total_paid;
    END IF;


    ----------------------------------------------------------------------
    -- Complete participants
    ----------------------------------------------------------------------

    UPDATE public.bingo_participants
    SET status = 'completed'
    WHERE game_id = p_game_id
      AND status = 'active';


    ----------------------------------------------------------------------
    -- Complete game
    ----------------------------------------------------------------------

    UPDATE public.bingo_games
    SET
        status = 'completed',
        is_split = (v_winner_count > 1),
        ended_at = NOW()
    WHERE id = p_game_id;


    ----------------------------------------------------------------------
    -- Return settlement result
    ----------------------------------------------------------------------

    RETURN jsonb_build_object(
        'success', TRUE,

        'game_id',
        v_game.id,

        'game_code',
        v_game.game_code,

        'room_id',
        v_game.room_id,

        'stake_id',
        v_game.stake_id,

        'stake_amount',
        v_game.stake_amount,

        'gross_pot',
        v_game.gross_pot,

        'commission_amount',
        v_game.commission_amount,

        'prize_pool',
        v_game.prize_pool,

        'disqualification_policy',
        v_disqualification_policy,

        'candidate_winning_card_count',
        cardinality(v_candidate_card_ids),

        'eligible_winning_card_count',
        v_winner_count,

        'total_paid',
        v_total_paid,

        'is_split',
        (v_winner_count > 1),

        'winners',
        v_result_winners
    );

END;
$$;


ALTER FUNCTION public.end_bingo_game(p_game_id integer, p_winner_card_ids bigint[]) OWNER TO neondb_owner;

--
-- Name: end_bingo_game(integer, bigint[], bigint); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.end_bingo_game(p_game_id integer, p_winner_card_ids bigint[], p_game_system_id bigint) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_game                  public.bingo_games%ROWTYPE;
    v_disqualification_policy varchar(30);

    v_candidate_card_ids    bigint[];
    v_eligible_card_ids     bigint[];

    v_winner_count           integer;

    v_prize_pool_cents       bigint;
    v_base_payout_cents      bigint;
    v_remainder_cents        bigint;

    v_index                  integer;
    v_payout_cents           bigint;
    v_payout                 numeric;

    v_card                  RECORD;
    v_transaction_id        bigint;

    v_total_paid             numeric := 0;
    v_result_winners         jsonb := '[]'::jsonb;
BEGIN
    ----------------------------------------------------------------------
    -- Validate arguments
    ----------------------------------------------------------------------

    IF p_game_id IS NULL THEN
        RAISE EXCEPTION 'Game ID is required';
    END IF;

    IF p_game_system_id IS NULL THEN
        RAISE EXCEPTION 'Game system ID is required';
    END IF;

    IF p_winner_card_ids IS NULL
       OR cardinality(p_winner_card_ids) = 0 THEN
        RAISE EXCEPTION 'At least one winning card is required';
    END IF;


    ----------------------------------------------------------------------
    -- Normalize / deduplicate submitted participant-card IDs
    ----------------------------------------------------------------------

    SELECT ARRAY_AGG(card_id ORDER BY card_id)
    INTO v_candidate_card_ids
    FROM (
        SELECT DISTINCT card_id
        FROM unnest(p_winner_card_ids) AS card_id
    ) x;


    ----------------------------------------------------------------------
    -- Lock game
    ----------------------------------------------------------------------

    SELECT *
    INTO v_game
    FROM public.bingo_games
    WHERE id = p_game_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Bingo game % not found',
            p_game_id;
    END IF;


    ----------------------------------------------------------------------
    -- Validate game state
    ----------------------------------------------------------------------

    IF v_game.status = 'completed' THEN
        RAISE EXCEPTION
            'Bingo game % is already completed',
            p_game_id;
    END IF;

    IF v_game.status = 'cancelled' THEN
        RAISE EXCEPTION
            'Bingo game % is cancelled',
            p_game_id;
    END IF;


    ----------------------------------------------------------------------
    -- Get disqualification policy from the room
    ----------------------------------------------------------------------

    SELECT br.disqualification_policy
    INTO v_disqualification_policy
    FROM public.bingo_rooms br
    WHERE br.id = v_game.room_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Room % for game % was not found',
            v_game.room_id,
            p_game_id;
    END IF;


    ----------------------------------------------------------------------
    -- Validate policy
    ----------------------------------------------------------------------

    IF v_disqualification_policy NOT IN (
        'exclude_card',
        'exclude_participant',
        'include'
    ) THEN
        RAISE EXCEPTION
            'Invalid disqualification policy: %',
            v_disqualification_policy;
    END IF;


    ----------------------------------------------------------------------
    -- Validate prize pool
    ----------------------------------------------------------------------

    IF COALESCE(v_game.prize_pool, 0) <= 0 THEN
        RAISE EXCEPTION
            'Bingo game % has no prize pool',
            p_game_id;
    END IF;


    ----------------------------------------------------------------------
    -- Make sure every submitted participant-card belongs to this game
    ----------------------------------------------------------------------

    IF EXISTS (
        SELECT 1
        FROM unnest(v_candidate_card_ids) AS submitted_card_id
        WHERE NOT EXISTS (
            SELECT 1
            FROM public.bingo_participant_cards pc
            WHERE pc.id = submitted_card_id
              AND pc.game_id = p_game_id
        )
    ) THEN
        RAISE EXCEPTION
            'One or more winning cards do not belong to game %',
            p_game_id;
    END IF;


    ----------------------------------------------------------------------
    -- Lock candidate cards and their participants.
    ----------------------------------------------------------------------

    PERFORM 1
    FROM public.bingo_participant_cards pc
    JOIN public.bingo_participants bp
      ON bp.id = pc.participant_id
    WHERE pc.id = ANY(v_candidate_card_ids)
    ORDER BY pc.id
    FOR UPDATE OF pc, bp;


    ----------------------------------------------------------------------
    -- Determine eligible winners according to room policy.
    --
    -- exclude_card:
    --     A disqualified participant's candidate card is excluded.
    --
    -- exclude_participant:
    --     ALL candidate cards belonging to a disqualified participant
    --     are excluded.
    --
    -- include:
    --     Disqualification is ignored for settlement.
    ----------------------------------------------------------------------

    SELECT ARRAY_AGG(pc.id ORDER BY pc.id)
    INTO v_eligible_card_ids
    FROM public.bingo_participant_cards pc
    JOIN public.bingo_participants bp
      ON bp.id = pc.participant_id
    WHERE pc.id = ANY(v_candidate_card_ids)
      AND (
            v_disqualification_policy = 'include'

            OR (
                v_disqualification_policy = 'exclude_card'
                AND bp.is_disqualified = FALSE
            )

            OR (
                v_disqualification_policy = 'exclude_participant'
                AND bp.is_disqualified = FALSE
            )
      );


    ----------------------------------------------------------------------
    -- No eligible winners
    ----------------------------------------------------------------------

    IF v_eligible_card_ids IS NULL
       OR cardinality(v_eligible_card_ids) = 0 THEN

        RAISE EXCEPTION
            'No eligible winning cards remain after applying disqualification policy "%"',
            v_disqualification_policy;
    END IF;


    ----------------------------------------------------------------------
    -- Make sure an eligible card has not already been settled.
    --
    -- bingo_winners stores card_id rather than participant_card_id,
    -- so compare against the actual card_id.
    ----------------------------------------------------------------------

    IF EXISTS (
        SELECT 1
        FROM public.bingo_participant_cards pc
        WHERE pc.id = ANY(v_eligible_card_ids)
          AND EXISTS (
              SELECT 1
              FROM public.bingo_winners bw
              WHERE bw.game_id = p_game_id
                AND bw.card_id = pc.card_id
          )
    ) THEN
        RAISE EXCEPTION
            'One or more eligible winning cards have already been settled for game %',
            p_game_id;
    END IF;


    ----------------------------------------------------------------------
    -- Number of winning cards.
    --
    -- IMPORTANT:
    -- This is CARD count, not USER count.
    --
    -- If User A wins 3 cards and User B wins 1 card,
    -- winner_count = 4.
    ----------------------------------------------------------------------

    v_winner_count := cardinality(v_eligible_card_ids);


    ----------------------------------------------------------------------
    -- Convert prize pool to cents.
    ----------------------------------------------------------------------

    v_prize_pool_cents :=
        ROUND(v_game.prize_pool * 100)::bigint;

    v_base_payout_cents :=
        v_prize_pool_cents / v_winner_count;

    v_remainder_cents :=
        v_prize_pool_cents % v_winner_count;


    ----------------------------------------------------------------------
    -- Pay each eligible winning card.
    ----------------------------------------------------------------------

    v_index := 0;

    FOR v_card IN
        SELECT
            pc.id AS participant_card_id,
            pc.card_id,
            pc.participant_id,
            bp.user_id
        FROM public.bingo_participant_cards pc
        JOIN public.bingo_participants bp
          ON bp.id = pc.participant_id
        WHERE pc.id = ANY(v_eligible_card_ids)
        ORDER BY pc.id
    LOOP

        v_index := v_index + 1;


        ------------------------------------------------------------------
        -- Distribute remainder cents across first cards.
        ------------------------------------------------------------------

        v_payout_cents :=
            v_base_payout_cents
            + CASE
                WHEN v_index <= v_remainder_cents THEN 1
                ELSE 0
              END;

        v_payout :=
            v_payout_cents / 100.0;


        ------------------------------------------------------------------
        -- Record financial win.
        ------------------------------------------------------------------

        v_transaction_id :=
            public.record_game_win(
                v_card.user_id,
                v_payout,
                p_game_system_id,
                'bingo_game',
                v_game.id::text,

                format(
                    'bingo-win:%s:participant-card:%s',
                    v_game.id,
                    v_card.participant_card_id
                ),

                format(
                    'Bingo win for game %s, card %s',
                    v_game.game_code,
                    v_card.card_id
                ),

                jsonb_build_object(
                    'game_id', v_game.id,
                    'game_code', v_game.game_code,
                    'room_id', v_game.room_id,
                    'participant_id', v_card.participant_id,
                    'participant_card_id', v_card.participant_card_id,
                    'card_id', v_card.card_id,
                    'payout', v_payout,
                    'disqualification_policy',
                        v_disqualification_policy
                )
            );


        ------------------------------------------------------------------
        -- Record winning card.
        ------------------------------------------------------------------

        INSERT INTO public.bingo_winners (
            game_id,
            participant_id,
            user_id,
            card_id,
            payout,
            transaction_id
        )
        VALUES (
            v_game.id,
            v_card.participant_id,
            v_card.user_id,
            v_card.card_id,
            v_payout,
            v_transaction_id
        );


        ------------------------------------------------------------------
        -- Participant-level settlement total.
        ------------------------------------------------------------------

        UPDATE public.bingo_participants
        SET amount_won =
            COALESCE(amount_won, 0) + v_payout
        WHERE id = v_card.participant_id;


        ------------------------------------------------------------------
        -- Add winner to response.
        ------------------------------------------------------------------

        v_result_winners :=
            v_result_winners ||
            jsonb_build_array(
                jsonb_build_object(
                    'participant_card_id',
                    v_card.participant_card_id,

                    'card_id',
                    v_card.card_id,

                    'participant_id',
                    v_card.participant_id,

                    'user_id',
                    v_card.user_id,

                    'payout',
                    v_payout,

                    'transaction_id',
                    v_transaction_id
                )
            );


        v_total_paid :=
            v_total_paid + v_payout;

    END LOOP;


    ----------------------------------------------------------------------
    -- Final accounting safety check.
    ----------------------------------------------------------------------

    IF ROUND(v_total_paid * 100)::bigint <> v_prize_pool_cents THEN
        RAISE EXCEPTION
            'Settlement mismatch for game %. Prize pool: %, total paid: %',
            p_game_id,
            v_game.prize_pool,
            v_total_paid;
    END IF;


    ----------------------------------------------------------------------
    -- Complete participants.
    ----------------------------------------------------------------------

    UPDATE public.bingo_participants
    SET status = 'completed'
    WHERE game_id = p_game_id
      AND status = 'active';


    ----------------------------------------------------------------------
    -- Complete game.
    ----------------------------------------------------------------------

    UPDATE public.bingo_games
    SET
        status = 'completed',
        is_split = (v_winner_count > 1),
        ended_at = NOW()
    WHERE id = p_game_id;


    ----------------------------------------------------------------------
    -- Return settlement result.
    ----------------------------------------------------------------------

    RETURN jsonb_build_object(
        'success', TRUE,
        'game_id', v_game.id,
        'game_code', v_game.game_code,
        'room_id', v_game.room_id,

        'stake_id', v_game.stake_id,
        'stake_amount', v_game.stake_amount,

        'gross_pot', v_game.gross_pot,
        'commission_amount', v_game.commission_amount,
        'prize_pool', v_game.prize_pool,

        'disqualification_policy',
            v_disqualification_policy,

        'candidate_winning_card_count',
            cardinality(v_candidate_card_ids),

        'eligible_winning_card_count',
            v_winner_count,

        'total_paid',
            v_total_paid,

        'is_split',
            (v_winner_count > 1),

        'winners',
            v_result_winners
    );

END;
$$;


ALTER FUNCTION public.end_bingo_game(p_game_id integer, p_winner_card_ids bigint[], p_game_system_id bigint) OWNER TO neondb_owner;

--
-- Name: find_transfer_recipient(character varying); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.find_transfer_recipient(p_phone character varying) RETURNS TABLE(user_id integer, name character varying, phone character varying, telegram_id bigint)
    LANGUAGE sql STABLE
    AS $$
    SELECT
        u.id,
        u.name,
        u.phone,
        u.telegram_id
    FROM public.users u
    WHERE RIGHT(
        REGEXP_REPLACE(
            COALESCE(u.phone, ''),
            '[^0-9]',
            '',
            'g'
        ),
        9
    )
    =
    RIGHT(
        REGEXP_REPLACE(
            COALESCE(p_phone, ''),
            '[^0-9]',
            '',
            'g'
        ),
        9
    )
    AND u.is_active = TRUE
    AND u.is_blocked = FALSE
    LIMIT 1;
$$;


ALTER FUNCTION public.find_transfer_recipient(p_phone character varying) OWNER TO neondb_owner;

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
-- Name: transfer_rules; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.transfer_rules (
    id bigint NOT NULL,
    wallet_type character varying(20) NOT NULL,
    period character varying(20) NOT NULL,
    minimum_transfer_amount numeric(18,2) DEFAULT 0 NOT NULL,
    maximum_transfer_amount numeric(18,2),
    maximum_transfer_count integer,
    is_active boolean DEFAULT true NOT NULL,
    starts_at timestamp with time zone,
    ends_at timestamp with time zone,
    priority integer DEFAULT 0 NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    maximum_period_amount numeric(18,2),
    minimum_remaining_balance numeric(18,2) DEFAULT 0 NOT NULL,
    CONSTRAINT transfer_rules_maximum_check CHECK (((maximum_transfer_amount IS NULL) OR (maximum_transfer_amount > (0)::numeric))),
    CONSTRAINT transfer_rules_minimum_check CHECK ((minimum_transfer_amount >= (0)::numeric)),
    CONSTRAINT transfer_rules_minimum_remaining_balance_check CHECK ((minimum_remaining_balance >= (0)::numeric)),
    CONSTRAINT transfer_rules_period_amount_check CHECK (((maximum_period_amount IS NULL) OR (maximum_period_amount > (0)::numeric))),
    CONSTRAINT transfer_rules_period_check CHECK (((period)::text = ANY ((ARRAY['daily'::character varying, 'weekly'::character varying, 'monthly'::character varying, 'quarterly'::character varying, 'yearly'::character varying])::text[]))),
    CONSTRAINT transfer_rules_wallet_type_check CHECK (((wallet_type)::text = ANY ((ARRAY['main'::character varying, 'play'::character varying])::text[])))
);


ALTER TABLE public.transfer_rules OWNER TO neondb_owner;

--
-- Name: get_active_transfer_rule(character varying, character varying); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.get_active_transfer_rule(p_wallet_type character varying, p_period character varying) RETURNS public.transfer_rules
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    v_rule public.transfer_rules;
    v_now TIMESTAMPTZ := NOW();
BEGIN

    /* --------------------------------------------------------
       Validate wallet
       -------------------------------------------------------- */

    IF p_wallet_type IS NULL
       OR p_wallet_type NOT IN ('main', 'play') THEN

        RAISE EXCEPTION
            'Invalid wallet type: %. Expected main or play',
            p_wallet_type;

    END IF;


    /* --------------------------------------------------------
       Validate period
       -------------------------------------------------------- */

    IF p_period IS NULL
       OR p_period NOT IN (
            'daily',
            'weekly',
            'monthly',
            'quarterly',
            'yearly'
       ) THEN

        RAISE EXCEPTION
            'Invalid transfer rule period: %',
            p_period;

    END IF;


    /* --------------------------------------------------------
       Get highest-priority active rule.
       -------------------------------------------------------- */

    SELECT tr.*
    INTO v_rule
    FROM public.transfer_rules tr
    WHERE tr.wallet_type = p_wallet_type
      AND tr.period = p_period
      AND tr.is_active = TRUE

      AND (
          tr.starts_at IS NULL
          OR tr.starts_at <= v_now
      )

      AND (
          tr.ends_at IS NULL
          OR tr.ends_at >= v_now
      )

    ORDER BY
        tr.priority DESC,
        tr.id DESC

    LIMIT 1;


    RETURN v_rule;

END;
$$;


ALTER FUNCTION public.get_active_transfer_rule(p_wallet_type character varying, p_period character varying) OWNER TO neondb_owner;

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
-- Name: get_bingo_user_dashboard(integer); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.get_bingo_user_dashboard(p_user_id integer) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_user public.users%ROWTYPE;
    v_result JSONB;
BEGIN

    ----------------------------------------------------------------
    -- 1. Validate user ID
    ----------------------------------------------------------------

    IF p_user_id IS NULL OR p_user_id <= 0 THEN
        RAISE EXCEPTION 'Invalid user ID';
    END IF;


    ----------------------------------------------------------------
    -- 2. Load user
    ----------------------------------------------------------------

    SELECT *
    INTO v_user
    FROM public.users
    WHERE id = p_user_id;


    IF NOT FOUND THEN
        RAISE EXCEPTION
            'User % was not found',
            p_user_id;
    END IF;


    ----------------------------------------------------------------
    -- 3. Blocked users
    --
    -- Blocked takes priority over inactive.
    ----------------------------------------------------------------

    IF v_user.is_blocked = TRUE THEN

        RETURN jsonb_build_object(
            'status', 'blocked'
        );

    END IF;


    ----------------------------------------------------------------
    -- 4. Inactive users
    ----------------------------------------------------------------

    IF COALESCE(v_user.is_active, FALSE) = FALSE THEN

        RETURN jsonb_build_object(
            'status', 'inactive'
        );

    END IF;


    ----------------------------------------------------------------
    -- 5. Build active-user dashboard
    ----------------------------------------------------------------

    v_result := jsonb_build_object(

        ----------------------------------------------------------------
        -- User status
        ----------------------------------------------------------------

        'status',
        'active',


        ----------------------------------------------------------------
        -- User information
        ----------------------------------------------------------------

        'user',
        jsonb_build_object(

            'id',
            v_user.id,

            'name',
            v_user.name,

            'telegram_id',
            v_user.telegram_id,

            'phone',
            v_user.phone,

            'is_active',
            v_user.is_active,

            'is_blocked',
            v_user.is_blocked,

            'created_at',
            v_user.created_at,

            'last_seen',
            v_user.last_seen,

            'vip_tier_id',
            v_user.vip_tier_id

        ),


        ----------------------------------------------------------------
        -- All account balances
        --
        -- Current wallet types are:
        --   main
        --   play
        --   bonus
        ----------------------------------------------------------------

        'balances',
        COALESCE(
            (
                SELECT jsonb_agg(
                    jsonb_build_object(

                        'wallet_id',
                        w.id,

                        'wallet_type',
                        w.wallet_type,

                        'currency',
                        w.currency,

                        'balance',
                        COALESCE(
                            wb.balance,
                            0
                        ),

                        'is_active',
                        w.is_active,

                        'created_at',
                        w.created_at,

                        'updated_at',
                        w.updated_at

                    )
                    ORDER BY
                        CASE w.wallet_type
                            WHEN 'main' THEN 1
                            WHEN 'play' THEN 2
                            WHEN 'bonus' THEN 3
                            ELSE 4
                        END,
                        w.id
                )
                FROM public.wallets w
                LEFT JOIN public.wallet_balances wb
                    ON wb.wallet_id = w.id
                WHERE w.user_id = v_user.id
            ),
            '[]'::jsonb
        ),


        ----------------------------------------------------------------
        -- Overall Bingo statistics
        ----------------------------------------------------------------

        'summary',
        jsonb_build_object(

            'games_played',
            (
                SELECT COUNT(
                    DISTINCT bp.game_id
                )
                FROM public.bingo_participants bp
                JOIN public.bingo_games bg
                    ON bg.id = bp.game_id
                WHERE bp.user_id = v_user.id
                  AND bg.status <> 'cancelled'
            ),


            'games_won',
            (
                SELECT COUNT(
                    DISTINCT bw.game_id
                )
                FROM public.bingo_winners bw
                JOIN public.bingo_games bg
                    ON bg.id = bw.game_id
                WHERE bw.user_id = v_user.id
                  AND bg.status <> 'cancelled'
            ),


            'total_earned',
            COALESCE(
                (
                    SELECT ROUND(
                        SUM(bw.payout),
                        2
                    )
                    FROM public.bingo_winners bw
                    JOIN public.bingo_games bg
                        ON bg.id = bw.game_id
                    WHERE bw.user_id = v_user.id
                      AND bg.status <> 'cancelled'
                ),
                0.00
            )

        ),


        ----------------------------------------------------------------
        -- Active stakes
        --
        -- Every active stake is returned, even if the user has
        -- never played that stake.
        ----------------------------------------------------------------

        'stakes',
        COALESCE(
            (
                SELECT jsonb_agg(
                    jsonb_build_object(

                        ----------------------------------------------------------------
                        -- Stake properties
                        ----------------------------------------------------------------

                        'stake_id',
                        s.id,

                        'name',
                        s.name,

                        'display_name',
                        s.display_name,

                        'amount',
                        s.amount,

                        'display_order',
                        s.display_order,

                        'is_active',
                        s.is_active,

                        'created_at',
                        s.created_at,

                        'updated_at',
                        s.updated_at,


                        ----------------------------------------------------------------
                        -- User statistics for this stake
                        ----------------------------------------------------------------

                        'games_played',
                        COALESCE(
                            (
                                SELECT COUNT(
                                    DISTINCT bp.game_id
                                )
                                FROM public.bingo_participants bp
                                JOIN public.bingo_games bg
                                    ON bg.id = bp.game_id
                                WHERE bp.user_id = v_user.id
                                  AND bp.game_id IS NOT NULL
                                  AND bg.stake_id = s.id
                                  AND bg.status <> 'cancelled'
                            ),
                            0
                        ),


                        'games_won',
                        COALESCE(
                            (
                                SELECT COUNT(
                                    DISTINCT bw.game_id
                                )
                                FROM public.bingo_winners bw
                                JOIN public.bingo_games bg
                                    ON bg.id = bw.game_id
                                WHERE bw.user_id = v_user.id
                                  AND bg.stake_id = s.id
                                  AND bg.status <> 'cancelled'
                            ),
                            0
                        ),


                        'total_earned',
                        COALESCE(
                            (
                                SELECT ROUND(
                                    SUM(bw.payout),
                                    2
                                )
                                FROM public.bingo_winners bw
                                JOIN public.bingo_games bg
                                    ON bg.id = bw.game_id
                                WHERE bw.user_id = v_user.id
                                  AND bg.stake_id = s.id
                                  AND bg.status <> 'cancelled'
                            ),
                            0.00
                        ),


                        ----------------------------------------------------------------
                        -- Active rooms available for this stake
                        ----------------------------------------------------------------

                        'rooms',
                        COALESCE(
                            (
                                SELECT jsonb_agg(
                                    jsonb_build_object(

                                        ----------------------------------------------------------------
                                        -- Room properties
                                        ----------------------------------------------------------------

                                        'room_id',
                                        r.id,

                                        'name',
                                        r.name,

                                        'code',
                                        r.code,

                                        'description',
                                        r.description,

                                        'status',
                                        r.status,

                                        'min_players',
                                        r.min_players,

                                        'max_players',
                                        r.max_players,

                                        'card_count',
                                        r.card_count,

                                        'max_cards_per_player',
                                        r.max_cards_per_player,

                                        'selection_seconds',
                                        r.selection_seconds,

                                        'disqualification_policy',
                                        r.disqualification_policy,

                                        'bingo_mode_policy',
                                        r.bingo_mode_policy,

                                        'bingo_button_scope',
                                        r.bingo_button_scope,

                                        'commission_rule_id',
                                        r.commission_rule_id,

                                        'created_at',
                                        r.created_at,

                                        'updated_at',
                                        r.updated_at,


                                        ----------------------------------------------------------------
                                        -- Commission configuration
                                        ----------------------------------------------------------------

                                        'commission_rule',
                                        (
                                            SELECT jsonb_build_object(

                                                'id',
                                                cr.id,

                                                'name',
                                                cr.name,

                                                'code',
                                                cr.code,

                                                'commission_rate',
                                                cr.commission_rate,

                                                'stake_id',
                                                cr.stake_id,

                                                'room_id',
                                                cr.room_id,

                                                'priority',
                                                cr.priority,

                                                'is_active',
                                                cr.is_active,

                                                'starts_at',
                                                cr.starts_at,

                                                'ends_at',
                                                cr.ends_at

                                            )
                                            FROM public.bingo_commission_rules cr
                                            WHERE cr.id = r.commission_rule_id
                                        ),


                                        ----------------------------------------------------------------
                                        -- User statistics for this room
                                        ----------------------------------------------------------------

                                        'games_played',
                                        COALESCE(
                                            (
                                                SELECT COUNT(
                                                    DISTINCT bp.game_id
                                                )
                                                FROM public.bingo_participants bp
                                                JOIN public.bingo_games bg
                                                    ON bg.id = bp.game_id
                                                WHERE bp.user_id = v_user.id
                                                  AND bg.room_id = r.id
                                                  AND bg.stake_id = s.id
                                                  AND bg.status <> 'cancelled'
                                            ),
                                            0
                                        ),


                                        'games_won',
                                        COALESCE(
                                            (
                                                SELECT COUNT(
                                                    DISTINCT bw.game_id
                                                )
                                                FROM public.bingo_winners bw
                                                JOIN public.bingo_games bg
                                                    ON bg.id = bw.game_id
                                                WHERE bw.user_id = v_user.id
                                                  AND bg.room_id = r.id
                                                  AND bg.stake_id = s.id
                                                  AND bg.status <> 'cancelled'
                                            ),
                                            0
                                        ),


                                        'total_earned',
                                        COALESCE(
                                            (
                                                SELECT ROUND(
                                                    SUM(bw.payout),
                                                    2
                                                )
                                                FROM public.bingo_winners bw
                                                JOIN public.bingo_games bg
                                                    ON bg.id = bw.game_id
                                                WHERE bw.user_id = v_user.id
                                                  AND bg.room_id = r.id
                                                  AND bg.stake_id = s.id
                                                  AND bg.status <> 'cancelled'
                                            ),
                                            0.00
                                        )

                                    )
                                    ORDER BY
                                        r.name,
                                        r.id
                                )
                                FROM public.bingo_room_stakes brs
                                JOIN public.bingo_rooms r
                                    ON r.id = brs.room_id
                                WHERE brs.stake_id = s.id
                                  AND brs.status = 'active'
                                  AND r.status = 'active'
                            ),
                            '[]'::jsonb
                        )

                    )
                    ORDER BY
                        s.display_order,
                        s.amount,
                        s.id
                )
                FROM public.bingo_stakes s
                WHERE s.is_active = TRUE
            ),
            '[]'::jsonb
        )

    );


    ----------------------------------------------------------------
    -- 6. Return dashboard
    ----------------------------------------------------------------

    RETURN v_result;

END;
$$;


ALTER FUNCTION public.get_bingo_user_dashboard(p_user_id integer) OWNER TO neondb_owner;

--
-- Name: get_eligible_deposit_bonus_campaigns(integer, integer, numeric); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.get_eligible_deposit_bonus_campaigns(p_user_id integer, p_deposit_id integer, p_deposit_amount numeric) RETURNS TABLE(campaign_id bigint, campaign_code character varying, campaign_name character varying, bonus_type character varying, game_system_id bigint, amount numeric, percentage numeric, multiplier numeric, wagering_multiplier numeric, min_deposit_amount numeric, max_bonus_amount numeric, validity_hours integer, stackable boolean, stack_group character varying, priority integer)
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    v_is_first_deposit BOOLEAN;
BEGIN

    ----------------------------------------------------------------
    -- 1. Validate input
    ----------------------------------------------------------------

    IF p_user_id IS NULL OR p_user_id <= 0 THEN
        RAISE EXCEPTION 'Invalid user ID';
    END IF;

    IF p_deposit_id IS NULL OR p_deposit_id <= 0 THEN
        RAISE EXCEPTION 'Invalid deposit ID';
    END IF;

    IF p_deposit_amount IS NULL OR p_deposit_amount <= 0 THEN
        RETURN;
    END IF;


    ----------------------------------------------------------------
    -- 2. Verify the deposit belongs to the user
    ----------------------------------------------------------------

    IF NOT EXISTS (
        SELECT 1
        FROM public.deposits d
        WHERE d.id = p_deposit_id
          AND d.user_id = p_user_id
    ) THEN

        RAISE EXCEPTION
            'Deposit % does not belong to user %',
            p_deposit_id,
            p_user_id;

    END IF;


    ----------------------------------------------------------------
    -- 3. Determine whether this is the user's first completed
    --    deposit.
    --
    -- The current deposit may still be pending while this function
    -- is called, so we count completed deposits EXCLUDING this one.
    ----------------------------------------------------------------

    SELECT NOT EXISTS (
        SELECT 1
        FROM public.deposits d
        WHERE d.user_id = p_user_id
          AND d.status = 'completed'
          AND d.id <> p_deposit_id
    )
    INTO v_is_first_deposit;


    ----------------------------------------------------------------
    -- 4. Find eligible campaigns
    --
    -- We first build the complete eligible set.
    -- Stacking is resolved afterwards.
    ----------------------------------------------------------------

    RETURN QUERY

    WITH eligible AS (

        SELECT
            bc.id,
            bc.code,
            bc.name,
            bc.bonus_type,
            bc.game_system_id,
            bc.amount,
            bc.percentage,
            bc.multiplier,
            bc.wagering_multiplier,
            bc.min_deposit_amount,
            bc.max_bonus_amount,
            bc.validity_hours,
            bc.stackable,
            bc.stack_group,
            bc.priority,

            /*
             * A NULL stack_group means this campaign gets its
             * own isolated stack group.
             */
            COALESCE(
                NULLIF(BTRIM(bc.stack_group), ''),
                '__campaign_' || bc.id::TEXT
            ) AS effective_stack_group

        FROM public.bonus_campaigns bc

        WHERE bc.is_active = TRUE


        ----------------------------------------------------------------
        -- Campaign must currently be inside its active date window.
        ----------------------------------------------------------------

        AND (
            bc.starts_at IS NULL
            OR bc.starts_at <= NOW()
        )

        AND (
            bc.ends_at IS NULL
            OR bc.ends_at >= NOW()
        )


        ----------------------------------------------------------------
        -- Deposit-triggered campaigns.
        --
        -- welcome:
        --   only first successful deposit
        --
        -- deposit:
        --   normal deposit bonus
        --
        -- reload:
        --   deposits after the first deposit
        ----------------------------------------------------------------

        AND (
            (
                bc.bonus_type = 'welcome'
                AND v_is_first_deposit = TRUE
            )

            OR

            bc.bonus_type = 'deposit'

            OR

            (
                bc.bonus_type = 'reload'
                AND v_is_first_deposit = FALSE
            )
        )


        ----------------------------------------------------------------
        -- Minimum deposit requirement.
        --
        -- Only deposit/reload campaigns use min_deposit_amount.
        ----------------------------------------------------------------

        AND (
            bc.bonus_type = 'welcome'

            OR

            bc.min_deposit_amount IS NULL

            OR

            p_deposit_amount >= bc.min_deposit_amount
        )


        ----------------------------------------------------------------
        -- Do not select a campaign that has already been awarded
        -- for this exact deposit.
        ----------------------------------------------------------------

        AND NOT EXISTS (
            SELECT 1
            FROM public.user_bonuses ub
            WHERE ub.user_id = p_user_id
              AND ub.campaign_id = bc.id
              AND ub.source_type = 'deposit'
              AND ub.source_id = p_deposit_id::VARCHAR
        )

    ),

    ----------------------------------------------------------------
    -- 5. Resolve stacking.
    --
    -- If a stack group contains a non-stackable campaign,
    -- only the highest-priority non-stackable campaign wins.
    --
    -- Otherwise all eligible stackable campaigns survive.
    ----------------------------------------------------------------

    resolved AS (

        SELECT e.*

        FROM eligible e

        WHERE

            ----------------------------------------------------------------
            -- Case A:
            -- This group has no non-stackable campaign.
            --
            -- Therefore all stackable campaigns can coexist.
            ----------------------------------------------------------------

            (
                NOT EXISTS (
                    SELECT 1
                    FROM eligible conflict
                    WHERE conflict.effective_stack_group =
                          e.effective_stack_group

                      AND conflict.stackable = FALSE
                )

                AND e.stackable = TRUE
            )

            OR

            ----------------------------------------------------------------
            -- Case B:
            -- This group contains a non-stackable campaign.
            --
            -- Select only the highest-priority non-stackable campaign.
            ----------------------------------------------------------------

            (
                e.stackable = FALSE

                AND NOT EXISTS (
                    SELECT 1
                    FROM eligible higher
                    WHERE higher.effective_stack_group =
                          e.effective_stack_group

                      AND higher.stackable = FALSE

                      AND (
                          higher.priority > e.priority

                          OR (
                              higher.priority = e.priority
                              AND higher.id > e.id
                          )
                      )
                )
            )
    )

    SELECT
        r.id,
        r.code,
        r.name,
        r.bonus_type,
        r.game_system_id,
        r.amount,
        r.percentage,
        r.multiplier,
        r.wagering_multiplier,
        r.min_deposit_amount,
        r.max_bonus_amount,
        r.validity_hours,
        r.stackable,
        r.stack_group,
        r.priority

    FROM resolved r

    ORDER BY
        r.priority DESC,
        r.id ASC;

END;
$$;


ALTER FUNCTION public.get_eligible_deposit_bonus_campaigns(p_user_id integer, p_deposit_id integer, p_deposit_amount numeric) OWNER TO neondb_owner;

--
-- Name: get_eligible_deposit_bonus_campaigns(integer, bigint, numeric); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.get_eligible_deposit_bonus_campaigns(p_user_id integer, p_deposit_id bigint, p_deposit_amount numeric) RETURNS TABLE(campaign_id bigint, campaign_code character varying, campaign_name character varying, bonus_type character varying, game_system_id bigint, amount numeric, percentage numeric, multiplier numeric, wagering_multiplier numeric, min_deposit_amount numeric, max_bonus_amount numeric, validity_hours integer, stackable boolean, stack_group character varying, priority integer)
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    v_is_first_deposit BOOLEAN;
BEGIN

    ----------------------------------------------------------------
    -- 1. Validate input
    ----------------------------------------------------------------

    IF p_user_id IS NULL OR p_user_id <= 0 THEN
        RAISE EXCEPTION 'Invalid user ID';
    END IF;

    IF p_deposit_id IS NULL OR p_deposit_id <= 0 THEN
        RAISE EXCEPTION 'Invalid deposit ID';
    END IF;

    IF p_deposit_amount IS NULL OR p_deposit_amount <= 0 THEN
        RETURN;
    END IF;


    ----------------------------------------------------------------
    -- 2. Make sure the deposit belongs to this user
    ----------------------------------------------------------------

    IF NOT EXISTS (
        SELECT 1
        FROM public.deposits d
        WHERE d.id = p_deposit_id
          AND d.user_id = p_user_id
    ) THEN
        RAISE EXCEPTION
            'Deposit % does not belong to user %',
            p_deposit_id,
            p_user_id;
    END IF;


    ----------------------------------------------------------------
    -- 3. Determine whether this is the user's first completed
    --    deposit.
    --
    -- The current deposit is excluded because this function can
    -- be called before the deposit status is changed to completed.
    ----------------------------------------------------------------

    SELECT NOT EXISTS (
        SELECT 1
        FROM public.deposits d
        WHERE d.user_id = p_user_id
          AND d.status = 'completed'
          AND d.id <> p_deposit_id
    )
    INTO v_is_first_deposit;


    ----------------------------------------------------------------
    -- 4. Build eligible campaign set
    ----------------------------------------------------------------

    RETURN QUERY

    WITH eligible AS (

        SELECT
            bc.id,
            bc.code,
            bc.name,
            bc.bonus_type,
            bc.game_system_id,
            bc.amount,
            bc.percentage,
            bc.multiplier,
            bc.wagering_multiplier,
            bc.min_deposit_amount,
            bc.max_bonus_amount,
            bc.validity_hours,
            bc.stackable,
            bc.stack_group,
            bc.priority,

            /*
             * Campaigns without a stack group are isolated.
             *
             * Example:
             *
             * campaign 100 -> NULL
             * campaign 101 -> NULL
             *
             * These do NOT conflict with each other.
             */
            COALESCE(
                NULLIF(BTRIM(bc.stack_group), ''),
                '__campaign_' || bc.id::TEXT
            ) AS effective_stack_group

        FROM public.bonus_campaigns bc

        WHERE bc.is_active = TRUE


        ----------------------------------------------------------------
        -- Campaign date window
        ----------------------------------------------------------------

        AND (
            bc.starts_at IS NULL
            OR bc.starts_at <= NOW()
        )

        AND (
            bc.ends_at IS NULL
            OR bc.ends_at >= NOW()
        )


        ----------------------------------------------------------------
        -- Deposit campaign types
        ----------------------------------------------------------------

        AND (
            /*
             * Welcome bonus:
             * only the first successful deposit.
             */
            (
                bc.bonus_type = 'welcome'
                AND v_is_first_deposit = TRUE
            )

            OR

            /*
             * Normal deposit bonus.
             */
            bc.bonus_type = 'deposit'

            OR

            /*
             * Reload:
             * only after the user already has a completed deposit.
             */
            (
                bc.bonus_type = 'reload'
                AND v_is_first_deposit = FALSE
            )
        )


        ----------------------------------------------------------------
        -- Minimum deposit
        ----------------------------------------------------------------

        AND (
            bc.min_deposit_amount IS NULL
            OR p_deposit_amount >= bc.min_deposit_amount
        )


        ----------------------------------------------------------------
        -- Do not return the same campaign twice for this deposit.
        --
        -- This is an additional protection on top of the
        -- financial idempotency key used by award_bonus().
        ----------------------------------------------------------------

        AND NOT EXISTS (
            SELECT 1
            FROM public.user_bonuses ub
            WHERE ub.user_id = p_user_id
              AND ub.campaign_id = bc.id
              AND ub.source_type = 'deposit'
              AND ub.source_id = p_deposit_id::VARCHAR
        )
    ),

    ----------------------------------------------------------------
    -- 5. Resolve stacking
    ----------------------------------------------------------------

    resolved AS (

        SELECT e.*

        FROM eligible e

        WHERE

            ----------------------------------------------------------------
            -- CASE A
            --
            -- No non-stackable campaign exists in this group.
            --
            -- Therefore every stackable campaign can coexist.
            ----------------------------------------------------------------

            (
                e.stackable = TRUE

                AND NOT EXISTS (
                    SELECT 1
                    FROM eligible conflict
                    WHERE conflict.effective_stack_group =
                          e.effective_stack_group
                      AND conflict.stackable = FALSE
                )
            )

            OR

            ----------------------------------------------------------------
            -- CASE B
            --
            -- This is a non-stackable campaign.
            --
            -- It wins if there is no higher-priority non-stackable
            -- campaign in the same group.
            ----------------------------------------------------------------

            (
                e.stackable = FALSE

                AND NOT EXISTS (
                    SELECT 1
                    FROM eligible higher
                    WHERE higher.effective_stack_group =
                          e.effective_stack_group

                      AND higher.stackable = FALSE

                      AND (
                          higher.priority > e.priority

                          OR (
                              higher.priority = e.priority
                              AND higher.id > e.id
                          )
                      )
                )
            )
    )

    SELECT
        r.id,
        r.code,
        r.name,
        r.bonus_type,
        r.game_system_id,
        r.amount,
        r.percentage,
        r.multiplier,
        r.wagering_multiplier,
        r.min_deposit_amount,
        r.max_bonus_amount,
        r.validity_hours,
        r.stackable,
        r.stack_group,
        r.priority

    FROM resolved r

    ORDER BY
        r.priority DESC,
        r.id ASC;

END;
$$;


ALTER FUNCTION public.get_eligible_deposit_bonus_campaigns(p_user_id integer, p_deposit_id bigint, p_deposit_amount numeric) OWNER TO neondb_owner;

--
-- Name: stake_funding_policies; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.stake_funding_policies (
    id bigint NOT NULL,
    game_system_id bigint,
    policy_code character varying(30) NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    starts_at timestamp with time zone,
    ends_at timestamp with time zone,
    priority integer DEFAULT 0 NOT NULL,
    description text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    name character varying(100) NOT NULL,
    CONSTRAINT stake_funding_policies_dates_check CHECK (((starts_at IS NULL) OR (ends_at IS NULL) OR (starts_at <= ends_at))),
    CONSTRAINT stake_funding_policies_metadata_object_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT stake_funding_policies_policy_check CHECK (((policy_code)::text = ANY ((ARRAY['play_first'::character varying, 'main_first'::character varying, 'play_only'::character varying, 'main_only'::character varying, 'bonus_first'::character varying])::text[]))),
    CONSTRAINT stake_funding_policies_priority_check CHECK ((priority >= 0))
);


ALTER TABLE public.stake_funding_policies OWNER TO neondb_owner;

--
-- Name: get_stake_funding_policy(bigint); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.get_stake_funding_policy(p_game_system_id bigint) RETURNS public.stake_funding_policies
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    v_policy public.stake_funding_policies;
    v_now TIMESTAMPTZ := NOW();
BEGIN

    IF p_game_system_id IS NULL THEN
        RAISE EXCEPTION
            'Game system ID is required for stake funding policy';
    END IF;


    SELECT sfp.*
    INTO v_policy
    FROM public.stake_funding_policies sfp
    WHERE sfp.is_active = TRUE

      AND (
            sfp.starts_at IS NULL
            OR sfp.starts_at <= v_now
          )

      AND (
            sfp.ends_at IS NULL
            OR sfp.ends_at >= v_now
          )

      AND (
            sfp.game_system_id = p_game_system_id
            OR sfp.game_system_id IS NULL
          )

    ORDER BY
        CASE
            WHEN sfp.game_system_id = p_game_system_id
            THEN 0
            ELSE 1
        END,

        sfp.priority DESC,
        sfp.id DESC

    LIMIT 1;


    IF NOT FOUND THEN
        RAISE EXCEPTION
            'No active stake funding policy found for game system %',
            p_game_system_id;
    END IF;


    RETURN v_policy;

END;
$$;


ALTER FUNCTION public.get_stake_funding_policy(p_game_system_id bigint) OWNER TO neondb_owner;

--
-- Name: get_transfer_limits(integer, character varying); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.get_transfer_limits(p_user_id integer, p_wallet_type character varying) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$

DECLARE

    v_balance NUMERIC(18,2);
    v_rule public.transfer_rules%ROWTYPE;

    v_max_transferable NUMERIC(18,2);
    v_balance_after_minimum NUMERIC(18,2);

BEGIN

    -- ========================================================
    -- 1. Validate user ID
    -- ========================================================

    IF p_user_id IS NULL OR p_user_id <= 0 THEN

        RAISE EXCEPTION
            'Invalid user ID';

    END IF;


    -- ========================================================
    -- 2. Validate wallet type
    -- ========================================================

    IF p_wallet_type NOT IN ('main', 'play') THEN

        RAISE EXCEPTION
            'Invalid wallet type. Use main or play';

    END IF;


    -- ========================================================
    -- 3. Get active daily transfer rule
    -- ========================================================

    v_rule :=
        public.get_active_transfer_rule(
            p_wallet_type,
            'daily'
        );


    IF v_rule.id IS NULL THEN

        RAISE EXCEPTION
            'No active transfer rule exists for % wallet',
            p_wallet_type;

    END IF;


    -- ========================================================
    -- 4. Get user's wallet balance
    -- ========================================================

    SELECT wb.balance
    INTO v_balance

    FROM public.wallets w

    JOIN public.wallet_balances wb
        ON wb.wallet_id = w.id

    WHERE w.user_id = p_user_id
      AND w.wallet_type = p_wallet_type

    LIMIT 1;


    IF v_balance IS NULL THEN

        RAISE EXCEPTION
            '% wallet not found for user',
            p_wallet_type;

    END IF;


    v_balance := ROUND(
        v_balance,
        2
    );


    -- ========================================================
    -- 5. Calculate balance that can actually be transferred
    --
    -- Example:
    --
    -- Balance                  = 1000
    -- Minimum remaining        = 200
    --
    -- Transferable from
    -- remaining-balance rule  = 800
    -- ========================================================

    v_balance_after_minimum :=
        GREATEST(
            v_balance
            - COALESCE(
                v_rule.minimum_remaining_balance,
                0
            ),
            0
        );


    -- ========================================================
    -- 6. Apply maximum per-transfer limit
    --
    -- Actual maximum is the smaller of:
    --
    -- balance - minimum remaining balance
    -- OR
    -- configured maximum transfer amount
    -- ========================================================

    IF v_rule.maximum_transfer_amount IS NULL THEN

        v_max_transferable :=
            v_balance_after_minimum;

    ELSE

        v_max_transferable :=
            LEAST(
                v_balance_after_minimum,
                v_rule.maximum_transfer_amount
            );

    END IF;


    v_max_transferable :=
        GREATEST(
            ROUND(
                v_max_transferable,
                2
            ),
            0
        );


    -- ========================================================
    -- 7. Return transfer limits
    -- ========================================================

    RETURN jsonb_build_object(

        'success',
        TRUE,

        'user_id',
        p_user_id,

        'wallet_type',
        p_wallet_type,

        'balance',
        v_balance,

        'minimum_transfer_amount',
        COALESCE(
            v_rule.minimum_transfer_amount,
            0
        ),

        'maximum_transfer_amount',
        v_rule.maximum_transfer_amount,

        'minimum_remaining_balance',
        COALESCE(
            v_rule.minimum_remaining_balance,
            0
        ),

        'maximum_transferable_now',
        v_max_transferable,

        'daily_transfer_count_limit',
        v_rule.maximum_transfer_count,

        'daily_transfer_amount_limit',
        v_rule.maximum_transfer_amount,

        'rule_id',
        v_rule.id

    );

END;

$$;


ALTER FUNCTION public.get_transfer_limits(p_user_id integer, p_wallet_type character varying) OWNER TO neondb_owner;

--
-- Name: users; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.users (
    id integer NOT NULL,
    telegram_id bigint NOT NULL,
    name character varying(50) NOT NULL,
    phone character varying(20),
    created_at timestamp with time zone DEFAULT now(),
    last_seen timestamp with time zone DEFAULT now(),
    is_active boolean DEFAULT true,
    is_admin boolean DEFAULT false NOT NULL,
    admin_role character varying(20),
    is_blocked boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    referral_code character varying(50),
    referred_by_user_id bigint,
    vip_tier_id bigint,
    CONSTRAINT users_admin_role_check CHECK (((admin_role IS NULL) OR ((admin_role)::text = ANY ((ARRAY['main'::character varying, 'statistics'::character varying, 'withdrawal'::character varying, 'broadcast'::character varying])::text[]))))
);


ALTER TABLE public.users OWNER TO neondb_owner;

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
    CONSTRAINT wallets_wallet_type_check CHECK (((wallet_type)::text = ANY ((ARRAY['main'::character varying, 'play'::character varying, 'bonus'::character varying])::text[])))
);


ALTER TABLE public.wallets OWNER TO neondb_owner;

--
-- Name: user_wallet_balances; Type: VIEW; Schema: public; Owner: neondb_owner
--

CREATE VIEW public.user_wallet_balances AS
 SELECT u.id AS user_id,
    u.telegram_id,
    u.name,
    u.phone,
    main_wallet.id AS main_wallet_id,
    (COALESCE(main_balance.balance, (0)::numeric))::numeric(18,2) AS main_balance,
    play_wallet.id AS play_wallet_id,
    (COALESCE(play_balance.balance, (0)::numeric))::numeric(18,2) AS play_balance,
    ((COALESCE(main_balance.balance, (0)::numeric) + COALESCE(play_balance.balance, (0)::numeric)) + COALESCE(bonus_balance.balance, (0)::numeric)) AS total_balance,
    bonus_wallet.id AS bonus_wallet_id,
    (COALESCE(bonus_balance.balance, (0)::numeric))::numeric(18,2) AS bonus_balance
   FROM ((((((public.users u
     LEFT JOIN public.wallets main_wallet ON (((main_wallet.user_id = u.id) AND ((main_wallet.wallet_type)::text = 'main'::text))))
     LEFT JOIN public.wallet_balances main_balance ON ((main_balance.wallet_id = main_wallet.id)))
     LEFT JOIN public.wallets play_wallet ON (((play_wallet.user_id = u.id) AND ((play_wallet.wallet_type)::text = 'play'::text))))
     LEFT JOIN public.wallet_balances play_balance ON ((play_balance.wallet_id = play_wallet.id)))
     LEFT JOIN public.wallets bonus_wallet ON (((bonus_wallet.user_id = u.id) AND ((bonus_wallet.wallet_type)::text = 'bonus'::text))))
     LEFT JOIN public.wallet_balances bonus_balance ON ((bonus_balance.wallet_id = bonus_wallet.id)));


ALTER VIEW public.user_wallet_balances OWNER TO neondb_owner;

--
-- Name: get_user_wallet_balances(bigint); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.get_user_wallet_balances(p_telegram_id bigint) RETURNS SETOF public.user_wallet_balances
    LANGUAGE sql STABLE
    AS $$
    SELECT *
    FROM public.user_wallet_balances
    WHERE telegram_id = p_telegram_id;
$$;


ALTER FUNCTION public.get_user_wallet_balances(p_telegram_id bigint) OWNER TO neondb_owner;

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
-- Name: get_user_wallet_id(bigint, character varying); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.get_user_wallet_id(p_user_id bigint, p_wallet_type character varying) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_wallet_id BIGINT;
BEGIN

    IF p_wallet_type NOT IN (
        'main',
        'play',
        'bonus'
    ) THEN
        RAISE EXCEPTION
            'Invalid wallet type: %',
            p_wallet_type;
    END IF;

    SELECT id
    INTO v_wallet_id
    FROM public.wallets
    WHERE user_id = p_user_id
      AND wallet_type = p_wallet_type
      AND is_active = TRUE
    LIMIT 1;

    IF v_wallet_id IS NULL THEN
        RAISE EXCEPTION
            'Active % wallet not found for user %',
            p_wallet_type,
            p_user_id;
    END IF;

    RETURN v_wallet_id;

END;
$$;


ALTER FUNCTION public.get_user_wallet_id(p_user_id bigint, p_wallet_type character varying) OWNER TO neondb_owner;

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
    v_policy public.stake_funding_policies%ROWTYPE;

    v_main_wallet_id BIGINT;
    v_play_wallet_id BIGINT;
    v_bonus_wallet_id BIGINT;

    v_main_balance NUMERIC(18,2) := 0;
    v_play_balance NUMERIC(18,2) := 0;
    v_bonus_balance NUMERIC(18,2) := 0;

    v_main_charge NUMERIC(18,2) := 0;
    v_play_charge NUMERIC(18,2) := 0;
    v_bonus_charge NUMERIC(18,2) := 0;

    v_total_available NUMERIC(18,2) := 0;
    v_remaining NUMERIC(18,2) := 0;
    v_charge NUMERIC(18,2) := 0;

    v_transaction_id BIGINT;
    v_transaction_created BOOLEAN;

    v_bonus_consumed NUMERIC(18,2) := 0;
    v_bonus_wagering NUMERIC(18,2) := 0;

    v_effective_metadata JSONB;
    v_contributions JSONB := '[]'::JSONB;

    v_policy_wallet RECORD;
BEGIN
    ----------------------------------------------------------------
    -- 1. Validate amount
    ----------------------------------------------------------------
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'Stake amount must be greater than zero';
    END IF;

    IF p_user_id IS NULL OR p_user_id <= 0 THEN
        RAISE EXCEPTION 'Invalid user ID';
    END IF;

    IF p_game_system_id IS NULL THEN
        RAISE EXCEPTION 'Game system ID is required for stake';
    END IF;

    ----------------------------------------------------------------
    -- 2. Resolve applicable policy
    ----------------------------------------------------------------
    SELECT *
    INTO v_policy
    FROM public.get_stake_funding_policy(p_game_system_id);

    ----------------------------------------------------------------
    -- 3. Get wallets
    ----------------------------------------------------------------
    v_main_wallet_id := public.get_user_wallet_id(
        p_user_id,
        'main'
    );

    v_play_wallet_id := public.get_user_wallet_id(
        p_user_id,
        'play'
    );

    v_bonus_wallet_id := public.get_user_wallet_id(
        p_user_id,
        'bonus'
    );

    ----------------------------------------------------------------
    -- 4. Lock wallets deterministically
    ----------------------------------------------------------------
    IF v_main_wallet_id < v_play_wallet_id
       AND v_main_wallet_id < v_bonus_wallet_id THEN

        PERFORM public.lock_wallet(v_main_wallet_id);

        IF v_play_wallet_id < v_bonus_wallet_id THEN
            PERFORM public.lock_wallet(v_play_wallet_id);
            PERFORM public.lock_wallet(v_bonus_wallet_id);
        ELSE
            PERFORM public.lock_wallet(v_bonus_wallet_id);
            PERFORM public.lock_wallet(v_play_wallet_id);
        END IF;

    ELSIF v_play_wallet_id < v_main_wallet_id
          AND v_play_wallet_id < v_bonus_wallet_id THEN

        PERFORM public.lock_wallet(v_play_wallet_id);

        IF v_main_wallet_id < v_bonus_wallet_id THEN
            PERFORM public.lock_wallet(v_main_wallet_id);
            PERFORM public.lock_wallet(v_bonus_wallet_id);
        ELSE
            PERFORM public.lock_wallet(v_bonus_wallet_id);
            PERFORM public.lock_wallet(v_main_wallet_id);
        END IF;

    ELSE

        PERFORM public.lock_wallet(v_bonus_wallet_id);

        IF v_main_wallet_id < v_play_wallet_id THEN
            PERFORM public.lock_wallet(v_main_wallet_id);
            PERFORM public.lock_wallet(v_play_wallet_id);
        ELSE
            PERFORM public.lock_wallet(v_play_wallet_id);
            PERFORM public.lock_wallet(v_main_wallet_id);
        END IF;

    END IF;

    ----------------------------------------------------------------
    -- 5. Read locked balances
    ----------------------------------------------------------------
    SELECT balance
    INTO v_main_balance
    FROM public.wallet_balances
    WHERE wallet_id = v_main_wallet_id;

    SELECT balance
    INTO v_play_balance
    FROM public.wallet_balances
    WHERE wallet_id = v_play_wallet_id;

    SELECT balance
    INTO v_bonus_balance
    FROM public.wallet_balances
    WHERE wallet_id = v_bonus_wallet_id;

    v_main_balance := COALESCE(v_main_balance, 0);
    v_play_balance := COALESCE(v_play_balance, 0);
    v_bonus_balance := COALESCE(v_bonus_balance, 0);

    ----------------------------------------------------------------
    -- 6. Calculate total available
    ----------------------------------------------------------------
    SELECT COALESCE(
        SUM(
            CASE sfpw.wallet_type
                WHEN 'main' THEN v_main_balance
                WHEN 'play' THEN v_play_balance
                WHEN 'bonus' THEN v_bonus_balance
                ELSE 0
            END
        ),
        0
    )
    INTO v_total_available
    FROM public.stake_funding_policy_wallets sfpw
    WHERE sfpw.policy_id = v_policy.id
      AND sfpw.is_active = TRUE;

    IF v_total_available < p_amount THEN
        RAISE EXCEPTION
            'Insufficient balance. Required: %, Available: %',
            p_amount,
            v_total_available;
    END IF;

    ----------------------------------------------------------------
    -- 7. Determine funding
    ----------------------------------------------------------------
    v_remaining := ROUND(p_amount, 2);

    FOR v_policy_wallet IN
        SELECT
            sfpw.wallet_type,
            sfpw.funding_order
        FROM public.stake_funding_policy_wallets sfpw
        WHERE sfpw.policy_id = v_policy.id
          AND sfpw.is_active = TRUE
        ORDER BY sfpw.funding_order
    LOOP
        EXIT WHEN v_remaining <= 0;

        CASE v_policy_wallet.wallet_type

            WHEN 'play' THEN

                v_charge := LEAST(
                    v_play_balance,
                    v_remaining
                );

                v_play_charge := ROUND(
                    v_play_charge + v_charge,
                    2
                );

                v_play_balance := ROUND(
                    v_play_balance - v_charge,
                    2
                );

            WHEN 'main' THEN

                v_charge := LEAST(
                    v_main_balance,
                    v_remaining
                );

                v_main_charge := ROUND(
                    v_main_charge + v_charge,
                    2
                );

                v_main_balance := ROUND(
                    v_main_balance - v_charge,
                    2
                );

            WHEN 'bonus' THEN

                v_charge := LEAST(
                    v_bonus_balance,
                    v_remaining
                );

                v_bonus_charge := ROUND(
                    v_bonus_charge + v_charge,
                    2
                );

                v_bonus_balance := ROUND(
                    v_bonus_balance - v_charge,
                    2
                );

            ELSE

                RAISE EXCEPTION
                    'Unsupported wallet type "%" in stake funding policy %',
                    v_policy_wallet.wallet_type,
                    v_policy.id;

        END CASE;

        IF v_charge > 0 THEN

            v_contributions := v_contributions
                || jsonb_build_object(
                    'wallet_type',
                    v_policy_wallet.wallet_type,
                    'funding_order',
                    v_policy_wallet.funding_order,
                    'amount',
                    ROUND(v_charge, 2)
                );

            v_remaining := ROUND(
                v_remaining - v_charge,
                2
            );

        END IF;
    END LOOP;

    ----------------------------------------------------------------
    -- 8. Validate funding
    ----------------------------------------------------------------
    IF v_remaining <> 0 THEN
        RAISE EXCEPTION
            'Stake funding mismatch. Required: %, Unfunded: %',
            p_amount,
            v_remaining;
    END IF;

    IF ROUND(
        v_play_charge
        + v_main_charge
        + v_bonus_charge,
        2
    ) <> ROUND(p_amount, 2) THEN

        RAISE EXCEPTION
            'Stake funding mismatch. Required: %, Funded: %',
            p_amount,
            v_play_charge
            + v_main_charge
            + v_bonus_charge;

    END IF;

    ----------------------------------------------------------------
    -- 9. Build transaction metadata
    ----------------------------------------------------------------
    v_effective_metadata :=
        COALESCE(p_metadata, '{}'::JSONB)
        || jsonb_build_object(
            'stake_funding_policy_id',
            v_policy.id,

            'stake_funding_policy_name',
            v_policy.name,

            'stake_funding_contributions',
            v_contributions
        );

    ----------------------------------------------------------------
    -- 10. Create / retrieve transaction
    ----------------------------------------------------------------
    SELECT
        t.transaction_id,
        t.created
    INTO
        v_transaction_id,
        v_transaction_created
    FROM public.create_financial_transaction(
        p_user_id,
        'stake',
        'completed',
        p_game_system_id,
        p_source_type,
        p_source_id,
        p_idempotency_key,
        p_description,
        v_effective_metadata
    ) AS t;

    ----------------------------------------------------------------
    -- 11. Idempotent retry
    ----------------------------------------------------------------
    IF NOT v_transaction_created THEN
        RETURN v_transaction_id;
    END IF;

    ----------------------------------------------------------------
    -- 12. PLAY ledger
    ----------------------------------------------------------------
    IF v_play_charge > 0 THEN

        INSERT INTO public.ledger_entries (
            transaction_id,
            wallet_id,
            amount
        )
        VALUES (
            v_transaction_id,
            v_play_wallet_id,
            -v_play_charge
        );

        UPDATE public.wallet_balances
        SET
            balance = balance - v_play_charge,
            updated_at = NOW()
        WHERE wallet_id = v_play_wallet_id;

    END IF;

    ----------------------------------------------------------------
    -- 13. MAIN ledger
    ----------------------------------------------------------------
    IF v_main_charge > 0 THEN

        INSERT INTO public.ledger_entries (
            transaction_id,
            wallet_id,
            amount
        )
        VALUES (
            v_transaction_id,
            v_main_wallet_id,
            -v_main_charge
        );

        UPDATE public.wallet_balances
        SET
            balance = balance - v_main_charge,
            updated_at = NOW()
        WHERE wallet_id = v_main_wallet_id;

    END IF;

    ----------------------------------------------------------------
    -- 14. BONUS ledger + bonus accounting
    ----------------------------------------------------------------
    IF v_bonus_charge > 0 THEN

        INSERT INTO public.ledger_entries (
            transaction_id,
            wallet_id,
            amount
        )
        VALUES (
            v_transaction_id,
            v_bonus_wallet_id,
            -v_bonus_charge
        );

        UPDATE public.wallet_balances
        SET
            balance = balance - v_bonus_charge,
            updated_at = NOW()
        WHERE wallet_id = v_bonus_wallet_id;

        ----------------------------------------------------------------
        -- Record Bonus consumption.
        --
        -- The function returns:
        --   consumed_amount
        --   wagering_amount
        ----------------------------------------------------------------
        SELECT
            r.consumed_amount,
            r.wagering_amount
        INTO
            v_bonus_consumed,
            v_bonus_wagering
        FROM public.consume_bonus_for_stake(
            p_user_id,
            v_transaction_id,
            v_bonus_charge
        ) AS r;

        ----------------------------------------------------------------
        -- The Bonus wallet debit must exactly match the amount
        -- allocated to Bonus entitlements.
        ----------------------------------------------------------------
        IF ROUND(v_bonus_consumed, 2)
           <> ROUND(v_bonus_charge, 2) THEN

            RAISE EXCEPTION
                'Bonus consumption mismatch. Bonus charge: %, Consumed: %',
                v_bonus_charge,
                v_bonus_consumed;

        END IF;

        ----------------------------------------------------------------
        -- Add Bonus accounting details to transaction metadata.
        ----------------------------------------------------------------
        UPDATE public.financial_transactions
        SET metadata =
            metadata
            || jsonb_build_object(
                'bonus_consumed_amount',
                v_bonus_consumed,

                'bonus_wagering_amount',
                v_bonus_wagering
            )
        WHERE id = v_transaction_id;

    END IF;

    ----------------------------------------------------------------
    -- 15. Final safety check
    ----------------------------------------------------------------
    IF ROUND(
        v_play_charge
        + v_main_charge
        + v_bonus_charge,
        2
    ) <> ROUND(p_amount, 2) THEN

        RAISE EXCEPTION
            'Stake funding mismatch. Required: %, funded: %',
            p_amount,
            v_play_charge
            + v_main_charge
            + v_bonus_charge;

    END IF;

    ----------------------------------------------------------------
    -- 16. Return transaction ID
    ----------------------------------------------------------------
    RETURN v_transaction_id;

END;
$$;


ALTER FUNCTION public.place_stake(p_user_id integer, p_amount numeric, p_game_system_id bigint, p_source_type character varying, p_source_id character varying, p_idempotency_key character varying, p_description text, p_metadata jsonb) OWNER TO neondb_owner;

--
-- Name: prevent_ledger_entries_mutation(); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.prevent_ledger_entries_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION
        'ledger_entries is immutable: % operations are not allowed. Create a reversal/adjustment transaction instead.',
        TG_OP;

    RETURN NULL;
END;
$$;


ALTER FUNCTION public.prevent_ledger_entries_mutation() OWNER TO neondb_owner;

--
-- Name: record_game_win(integer, numeric, bigint, character varying, character varying, character varying, text, jsonb); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.record_game_win(p_user_id integer, p_amount numeric, p_game_system_id bigint, p_source_type character varying, p_source_id character varying, p_idempotency_key character varying, p_description text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_main_wallet_id BIGINT;

    v_transaction_id BIGINT;
    v_transaction_created BOOLEAN;
BEGIN

    -- --------------------------------------------------------
    -- Validate amount
    -- --------------------------------------------------------

    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION
            'Win amount must be greater than zero';
    END IF;


    -- --------------------------------------------------------
    -- Get Main wallet
    -- --------------------------------------------------------

    v_main_wallet_id :=
        get_user_wallet_id(
            p_user_id,
            'main'
        );


    -- --------------------------------------------------------
    -- Lock Main
    -- --------------------------------------------------------

    PERFORM lock_wallet(v_main_wallet_id);


    -- --------------------------------------------------------
    -- Create / retrieve transaction atomically
    -- --------------------------------------------------------

    SELECT
        t.transaction_id,
        t.created
    INTO
        v_transaction_id,
        v_transaction_created
    FROM create_financial_transaction(
        p_user_id,
        'win',
        'completed',
        p_game_system_id,
        p_source_type,
        p_source_id,
        p_idempotency_key,
        p_description,
        p_metadata
    ) AS t;


    -- --------------------------------------------------------
    -- Existing idempotent win.
    --
    -- Do NOT credit Main again.
    -- --------------------------------------------------------

    IF NOT v_transaction_created THEN
        RETURN v_transaction_id;
    END IF;


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
        ROUND(p_amount, 2)
    );


    -- --------------------------------------------------------
    -- Balance
    -- --------------------------------------------------------

    UPDATE wallet_balances
    SET
        balance = balance + ROUND(p_amount, 2),
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

    v_refund_transaction_id bigint;
    v_transaction_created boolean;

    v_wallet_id bigint;
    v_wallet_balance numeric(18,2);

    v_original_ledger RECORD;

    v_total_refund numeric(18,2) := 0;
    v_ledger_count integer := 0;

    v_refund_metadata jsonb;
BEGIN
    ----------------------------------------------------------------
    -- 1. Validate input
    ----------------------------------------------------------------
    IF p_user_id IS NULL OR p_user_id <= 0 THEN
        RAISE EXCEPTION 'Invalid user ID';
    END IF;

    IF p_original_transaction_id IS NULL
       OR p_original_transaction_id <= 0 THEN
        RAISE EXCEPTION 'Invalid original transaction ID';
    END IF;

    IF p_idempotency_key IS NULL
       OR BTRIM(p_idempotency_key) = '' THEN
        RAISE EXCEPTION 'Refund idempotency key is required';
    END IF;


    ----------------------------------------------------------------
    -- 2. Lock and validate the original stake transaction
    --
    -- This serializes multiple refund attempts for the same
    -- financial transaction.
    ----------------------------------------------------------------
    SELECT *
    INTO v_original
    FROM public.financial_transactions
    WHERE id = p_original_transaction_id
      AND user_id = p_user_id
      AND type = 'stake'
      AND status = 'completed'
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Completed stake transaction % for user % was not found',
            p_original_transaction_id,
            p_user_id;
    END IF;


    ----------------------------------------------------------------
    -- 3. Find every wallet movement created by the original stake
    --
    -- place_stake() can debit:
    --
    --   Play wallet
    --   Main wallet
    --
    -- Therefore we must reverse every negative ledger entry.
    ----------------------------------------------------------------
    FOR v_wallet_id IN
        SELECT DISTINCT le.wallet_id
        FROM public.ledger_entries le
        WHERE le.transaction_id = p_original_transaction_id
          AND le.amount < 0
        ORDER BY le.wallet_id
    LOOP

        ----------------------------------------------------------------
        -- Lock the wallet balance row.
        --
        -- IMPORTANT:
        -- The balance is stored in wallet_balances, not wallets.
        ----------------------------------------------------------------
        PERFORM public.lock_wallet(v_wallet_id);

    END LOOP;


    ----------------------------------------------------------------
    -- 4. Create/retrieve refund financial transaction
    --
    -- Description and metadata belong to financial_transactions.
    -- They do NOT belong to ledger_entries.
    ----------------------------------------------------------------
    v_refund_metadata :=
        COALESCE(p_metadata, '{}'::jsonb)
        || jsonb_build_object(
            'original_transaction_id',
            p_original_transaction_id
        );

    SELECT
        t.transaction_id,
        t.created
    INTO
        v_refund_transaction_id,
        v_transaction_created
    FROM public.create_financial_transaction(
        p_user_id,
        'refund',
        'completed',
        v_original.game_system_id,
        'stake_refund',
        p_original_transaction_id::text,
        p_idempotency_key,
        COALESCE(
            NULLIF(BTRIM(p_description), ''),
            'Refund of stake transaction '
                || p_original_transaction_id::text
        ),
        v_refund_metadata
    ) AS t;


    ----------------------------------------------------------------
    -- 5. Idempotent retry
    --
    -- If the refund transaction already exists, DO NOT:
    --
    --   - create another ledger entry
    --   - credit the wallet again
    --
    -- Just return the existing refund transaction.
    ----------------------------------------------------------------
    IF NOT v_transaction_created THEN

        ----------------------------------------------------------------
        -- Verify that the existing transaction really represents
        -- this refund operation.
        ----------------------------------------------------------------
        IF NOT EXISTS (
            SELECT 1
            FROM public.financial_transactions ft
            WHERE ft.id = v_refund_transaction_id
              AND ft.user_id = p_user_id
              AND ft.type = 'refund'
              AND ft.status = 'completed'
              AND ft.source_type = 'stake_refund'
              AND ft.source_id = p_original_transaction_id::text
        ) THEN
            RAISE EXCEPTION
                'Existing transaction % does not match stake refund %',
                v_refund_transaction_id,
                p_original_transaction_id;
        END IF;

        RETURN v_refund_transaction_id;
    END IF;


    ----------------------------------------------------------------
    -- 6. Prevent double refund
    --
    -- The original transaction is locked above, so concurrent
    -- refund attempts for this same transaction are serialized.
    ----------------------------------------------------------------
    IF EXISTS (
        SELECT 1
        FROM public.financial_transactions ft
        WHERE ft.reversed_transaction_id =
              p_original_transaction_id
    ) THEN
        RAISE EXCEPTION
            'Stake transaction % has already been refunded',
            p_original_transaction_id;
    END IF;


    ----------------------------------------------------------------
    -- 7. Link refund transaction to original stake transaction
    ----------------------------------------------------------------
    UPDATE public.financial_transactions
    SET
        reversed_transaction_id = p_original_transaction_id
    WHERE id = v_refund_transaction_id
      AND reversed_transaction_id IS NULL;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Failed to link refund transaction % to original stake transaction %',
            v_refund_transaction_id,
            p_original_transaction_id;
    END IF;


    ----------------------------------------------------------------
    -- 8. Reverse every negative ledger entry
    --
    -- Original:
    --
    --   Play  -70
    --   Main  -30
    --
    -- Refund:
    --
    --   Play  +70
    --   Main  +30
    --
    -- Total refund = 100
    ----------------------------------------------------------------
    FOR v_original_ledger IN
        SELECT
            le.wallet_id,
            le.amount
        FROM public.ledger_entries le
        WHERE le.transaction_id = p_original_transaction_id
          AND le.amount < 0
        ORDER BY le.wallet_id
    LOOP

        v_ledger_count :=
            v_ledger_count + 1;

        ----------------------------------------------------------------
        -- Insert the reversal ledger entry.
        --
        -- ledger_entries only contains:
        --
        --   transaction_id
        --   wallet_id
        --   amount
        --   created_at
        ----------------------------------------------------------------
        INSERT INTO public.ledger_entries (
            transaction_id,
            wallet_id,
            amount
        )
        VALUES (
            v_refund_transaction_id,
            v_original_ledger.wallet_id,
            ROUND(-v_original_ledger.amount, 2)
        );


        ----------------------------------------------------------------
        -- Restore the exact wallet that was originally charged.
        ----------------------------------------------------------------
        UPDATE public.wallet_balances
        SET
            balance = balance + ROUND(
                -v_original_ledger.amount,
                2
            ),
            updated_at = NOW()
        WHERE wallet_id = v_original_ledger.wallet_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION
                'Wallet balance % not found while refunding stake transaction %',
                v_original_ledger.wallet_id,
                p_original_transaction_id;
        END IF;


        ----------------------------------------------------------------
        -- Calculate total refund.
        ----------------------------------------------------------------
        v_total_refund :=
            v_total_refund
            + ROUND(-v_original_ledger.amount, 2);

    END LOOP;


    ----------------------------------------------------------------
    -- 9. A completed stake must have at least one negative ledger
    --    entry.
    ----------------------------------------------------------------
    IF v_ledger_count = 0
       OR v_total_refund <= 0 THEN

        RAISE EXCEPTION
            'Stake transaction % has no refundable ledger entries',
            p_original_transaction_id;

    END IF;


    ----------------------------------------------------------------
    -- 10. Final consistency check
    ----------------------------------------------------------------
    IF NOT EXISTS (
        SELECT 1
        FROM public.ledger_entries le
        WHERE le.transaction_id = v_refund_transaction_id
    ) THEN
        RAISE EXCEPTION
            'Refund transaction % has no ledger entries',
            v_refund_transaction_id;
    END IF;


    ----------------------------------------------------------------
    -- 11. Return refund transaction ID
    ----------------------------------------------------------------
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
    v_withdrawal withdrawals%ROWTYPE;
    v_original financial_transactions%ROWTYPE;

    v_refund_transaction_id bigint;
    v_transaction_created boolean;

    v_main_wallet_id bigint;
    v_refund_amount numeric(18,2);

    v_ledger_wallet_id bigint;
    v_ledger_amount numeric(18,2);

    v_refund_key varchar(150);
BEGIN
    ----------------------------------------------------------------
    -- 1. Validate input
    ----------------------------------------------------------------
    IF p_user_id IS NULL OR p_user_id <= 0 THEN
        RAISE EXCEPTION 'Invalid user ID';
    END IF;

    IF p_withdrawal_id IS NULL OR p_withdrawal_id <= 0 THEN
        RAISE EXCEPTION 'Invalid withdrawal ID';
    END IF;

    IF p_original_transaction_id IS NULL
       OR p_original_transaction_id <= 0 THEN
        RAISE EXCEPTION 'Invalid original transaction ID';
    END IF;


    ----------------------------------------------------------------
    -- 2. Lock the withdrawal
    --
    -- This serializes refund attempts for the same withdrawal.
    ----------------------------------------------------------------
    SELECT *
    INTO v_withdrawal
    FROM public.withdrawals
    WHERE id = p_withdrawal_id
      AND user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Withdrawal % for user % was not found',
            p_withdrawal_id,
            p_user_id;
    END IF;


    ----------------------------------------------------------------
    -- 3. Validate the withdrawal transaction
    ----------------------------------------------------------------
    SELECT *
    INTO v_original
    FROM public.financial_transactions
    WHERE id = p_original_transaction_id
      AND user_id = p_user_id
      AND type = 'withdrawal'
      AND status = 'completed'
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Completed withdrawal transaction % for user % was not found',
            p_original_transaction_id,
            p_user_id;
    END IF;


    ----------------------------------------------------------------
    -- 4. Verify the withdrawal points to this transaction
    ----------------------------------------------------------------
    IF v_withdrawal.transaction_id IS DISTINCT FROM p_original_transaction_id THEN
        RAISE EXCEPTION
            'Withdrawal % is not linked to transaction %',
            p_withdrawal_id,
            p_original_transaction_id;
    END IF;


    ----------------------------------------------------------------
    -- 5. Determine the exact amount that was reserved
    --
    -- reserve_withdrawal_from_main() creates:
    --
    --     ledger_entries.amount = -withdrawal_amount
    --
    -- Therefore the refund is the positive inverse.
    ----------------------------------------------------------------
    SELECT
        COALESCE(
            -SUM(le.amount),
            0
        )
    INTO v_refund_amount
    FROM public.ledger_entries le
    WHERE le.transaction_id = p_original_transaction_id
      AND le.amount < 0;

    v_refund_amount := ROUND(v_refund_amount, 2);

    IF v_refund_amount <= 0 THEN
        RAISE EXCEPTION
            'Withdrawal transaction % has no refundable ledger entry',
            p_original_transaction_id;
    END IF;


    ----------------------------------------------------------------
    -- 6. Validate the withdrawal amount against the ledger
    --
    -- This protects against a corrupted/mismatched withdrawal row.
    ----------------------------------------------------------------
    IF v_withdrawal.amount IS NULL
       OR ROUND(v_withdrawal.amount, 2) <> v_refund_amount THEN
        RAISE EXCEPTION
            'Withdrawal % amount mismatch. Withdrawal amount: %, ledger amount: %',
            p_withdrawal_id,
            v_withdrawal.amount,
            v_refund_amount;
    END IF;


    ----------------------------------------------------------------
    -- 7. Find the Main wallet
    ----------------------------------------------------------------
    SELECT w.id
    INTO v_main_wallet_id
    FROM public.wallets w
    WHERE w.user_id = p_user_id
      AND w.wallet_type = 'main'
      AND w.is_active = TRUE
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Active Main wallet for user % was not found',
            p_user_id;
    END IF;


    ----------------------------------------------------------------
    -- 8. Lock the Main wallet balance row
    --
    -- IMPORTANT:
    -- The actual balance is stored in wallet_balances,
    -- NOT wallets.balance.
    ----------------------------------------------------------------
    PERFORM 1
    FROM public.wallet_balances wb
    WHERE wb.wallet_id = v_main_wallet_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Main wallet balance for wallet % was not found',
            v_main_wallet_id;
    END IF;


    ----------------------------------------------------------------
    -- 9. Verify the original withdrawal ledger belongs to Main
    --
    -- reserve_withdrawal_from_main() should have created exactly
    -- one negative ledger entry against the Main wallet.
    ----------------------------------------------------------------
    SELECT
        le.wallet_id,
        le.amount
    INTO
        v_ledger_wallet_id,
        v_ledger_amount
    FROM public.ledger_entries le
    WHERE le.transaction_id = p_original_transaction_id
      AND le.amount < 0
    ORDER BY le.id
    LIMIT 1;

    IF v_ledger_wallet_id IS NULL THEN
        RAISE EXCEPTION
            'No negative ledger entry found for withdrawal transaction %',
            p_original_transaction_id;
    END IF;

    IF v_ledger_wallet_id <> v_main_wallet_id THEN
        RAISE EXCEPTION
            'Withdrawal transaction % does not belong to the user Main wallet',
            p_original_transaction_id;
    END IF;


    ----------------------------------------------------------------
    -- 10. Create/retrieve the refund transaction
    --
    -- If the caller does not provide an idempotency key, generate
    -- the canonical one for this withdrawal.
    ----------------------------------------------------------------
    v_refund_key :=
        COALESCE(
            NULLIF(BTRIM(p_idempotency_key), ''),
            'withdrawal:refund:' || p_withdrawal_id::text
        );

    SELECT
        t.transaction_id,
        t.created
    INTO
        v_refund_transaction_id,
        v_transaction_created
    FROM public.create_financial_transaction(
        p_user_id,
        'refund',
        'completed',
        v_original.game_system_id,
        'withdrawal_refund',
        p_withdrawal_id::text,
        v_refund_key,
        COALESCE(
            NULLIF(BTRIM(p_description), ''),
            'Refund of withdrawal ' || p_withdrawal_id::text
        ),
        jsonb_build_object(
            'withdrawal_id', p_withdrawal_id,
            'original_transaction_id', p_original_transaction_id,
            'refund_amount', v_refund_amount,
            'wallet_id', v_main_wallet_id,
            'reason', 'withdrawal_rejected'
        )
    ) AS t;


    ----------------------------------------------------------------
    -- 11. Idempotent retry
    --
    -- If the refund transaction already exists for this key,
    -- DO NOT create another ledger entry and DO NOT credit the
    -- wallet again.
    ----------------------------------------------------------------
    IF NOT v_transaction_created THEN

        -- Make sure the existing refund really belongs to
        -- this original withdrawal.
        IF NOT EXISTS (
            SELECT 1
            FROM public.financial_transactions ft
            WHERE ft.id = v_refund_transaction_id
              AND ft.type = 'refund'
              AND ft.user_id = p_user_id
              AND ft.reversed_transaction_id =
                    p_original_transaction_id
        ) THEN
            RAISE EXCEPTION
                'Existing refund transaction % is not a valid refund for withdrawal transaction %',
                v_refund_transaction_id,
                p_original_transaction_id;
        END IF;

        RETURN v_refund_transaction_id;
    END IF;


    ----------------------------------------------------------------
    -- 12. Make absolutely sure the original transaction has not
    -- already been reversed by another refund.
    ----------------------------------------------------------------
    IF EXISTS (
        SELECT 1
        FROM public.financial_transactions ft
        WHERE ft.reversed_transaction_id =
              p_original_transaction_id
    ) THEN
        RAISE EXCEPTION
            'Withdrawal transaction % has already been reversed',
            p_original_transaction_id;
    END IF;


    ----------------------------------------------------------------
    -- 13. Link refund transaction to original withdrawal
    ----------------------------------------------------------------
    UPDATE public.financial_transactions
    SET reversed_transaction_id = p_original_transaction_id
    WHERE id = v_refund_transaction_id
      AND reversed_transaction_id IS NULL;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Failed to link refund transaction % to withdrawal transaction %',
            v_refund_transaction_id,
            p_original_transaction_id;
    END IF;


    ----------------------------------------------------------------
    -- 14. Create the positive refund ledger entry
    --
    -- ledger_entries has ONLY:
    --   transaction_id
    --   wallet_id
    --   amount
    --   created_at
    --
    -- Description/metadata belong to financial_transactions.
    ----------------------------------------------------------------
    INSERT INTO public.ledger_entries (
        transaction_id,
        wallet_id,
        amount
    )
    VALUES (
        v_refund_transaction_id,
        v_main_wallet_id,
        v_refund_amount
    );


    ----------------------------------------------------------------
    -- 15. Restore the Main wallet balance
    ----------------------------------------------------------------
    UPDATE public.wallet_balances
    SET
        balance = balance + v_refund_amount,
        updated_at = NOW()
    WHERE wallet_id = v_main_wallet_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Failed to restore Main wallet balance for wallet %',
            v_main_wallet_id;
    END IF;


    ----------------------------------------------------------------
    -- 16. Final safety check
    ----------------------------------------------------------------
    IF NOT EXISTS (
        SELECT 1
        FROM public.ledger_entries
        WHERE transaction_id = v_refund_transaction_id
          AND wallet_id = v_main_wallet_id
          AND amount = v_refund_amount
    ) THEN
        RAISE EXCEPTION
            'Refund ledger entry was not created for transaction %',
            v_refund_transaction_id;
    END IF;


    ----------------------------------------------------------------
    -- 17. Return refund transaction ID
    ----------------------------------------------------------------
    RETURN v_refund_transaction_id;

END;
$$;


ALTER FUNCTION public.refund_withdrawal(p_user_id integer, p_withdrawal_id bigint, p_original_transaction_id bigint, p_idempotency_key character varying, p_description text) OWNER TO neondb_owner;

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
    v_transaction_created BOOLEAN;

    v_balance NUMERIC(18,2);
    v_amount NUMERIC(18,2);
BEGIN

    -- --------------------------------------------------------
    -- Validate amount
    -- --------------------------------------------------------

    v_amount := ROUND(p_amount, 2);

    IF v_amount <= 0 THEN
        RAISE EXCEPTION
            'Withdrawal amount must be greater than zero';
    END IF;


    -- --------------------------------------------------------
    -- Get Main wallet
    -- --------------------------------------------------------

    v_wallet_id :=
        get_user_wallet_id(
            p_user_id,
            'main'
        );


    -- --------------------------------------------------------
    -- Lock Main wallet
    -- --------------------------------------------------------

    PERFORM lock_wallet(v_wallet_id);


    -- --------------------------------------------------------
    -- Create / retrieve transaction atomically
    --
    -- This is deliberately BEFORE the balance check.
    --
    -- If this is an idempotent retry, we return the existing
    -- transaction rather than failing because the current balance
    -- has changed since the original request.
    -- --------------------------------------------------------

    SELECT
        t.transaction_id,
        t.created
    INTO
        v_transaction_id,
        v_transaction_created
    FROM create_financial_transaction(
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
    ) AS t;


    -- --------------------------------------------------------
    -- Existing idempotent withdrawal.
    --
    -- Do NOT debit Main again.
    -- --------------------------------------------------------

    IF NOT v_transaction_created THEN
        RETURN v_transaction_id;
    END IF;


    -- --------------------------------------------------------
    -- Read locked balance
    -- --------------------------------------------------------

    SELECT balance
    INTO v_balance
    FROM wallet_balances
    WHERE wallet_id = v_wallet_id;


    -- --------------------------------------------------------
    -- Check balance
    -- --------------------------------------------------------

    IF v_balance < v_amount THEN

        RAISE EXCEPTION
            'Insufficient Main wallet balance. Available: %, requested: %',
            v_balance,
            v_amount;

    END IF;


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
        v_wallet_id,
        -v_amount
    );


    -- --------------------------------------------------------
    -- Balance
    -- --------------------------------------------------------

    UPDATE wallet_balances
    SET
        balance = balance - v_amount,
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
-- Name: transfer_wallet(integer, character varying, character varying, numeric, character varying, text); Type: FUNCTION; Schema: public; Owner: neondb_owner
--

CREATE FUNCTION public.transfer_wallet(p_sender_user_id integer, p_receiver_phone character varying, p_wallet_type character varying, p_amount numeric, p_idempotency_key character varying, p_description text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$

DECLARE

    v_sender public.users%ROWTYPE;
    v_receiver public.users%ROWTYPE;

    v_sender_wallet_id BIGINT;
    v_receiver_wallet_id BIGINT;

    v_sender_balance NUMERIC(18,2);
    v_receiver_balance NUMERIC(18,2);

    v_amount NUMERIC(18,2);

    v_rule public.transfer_rules%ROWTYPE;

    v_daily_count INTEGER;
    v_weekly_count INTEGER;
    v_monthly_count INTEGER;
    v_quarterly_count INTEGER;
    v_yearly_count INTEGER;

    v_daily_amount NUMERIC(18,2);
    v_weekly_amount NUMERIC(18,2);
    v_monthly_amount NUMERIC(18,2);
    v_quarterly_amount NUMERIC(18,2);
    v_yearly_amount NUMERIC(18,2);

    v_transaction_id BIGINT;
    v_transaction_created BOOLEAN;

    v_transfer_id BIGINT;

    v_existing_transfer public.transfers%ROWTYPE;

    v_normalized_phone VARCHAR(20);

    v_remaining_balance NUMERIC(18,2);

    v_now TIMESTAMPTZ := NOW();


BEGIN

    -- ========================================================
    -- 1. Validate sender
    -- ========================================================

    IF p_sender_user_id IS NULL
       OR p_sender_user_id <= 0
    THEN

        RAISE EXCEPTION
            'Invalid sender user ID';

    END IF;


    SELECT *
    INTO v_sender
    FROM public.users
    WHERE id = p_sender_user_id
    FOR UPDATE;


    IF NOT FOUND THEN

        RAISE EXCEPTION
            'Sender user not found';

    END IF;


    IF v_sender.is_active IS NOT TRUE THEN

        RAISE EXCEPTION
            'Sender account is inactive';

    END IF;


    IF v_sender.is_blocked IS TRUE THEN

        RAISE EXCEPTION
            'Sender account is blocked';

    END IF;

    -- ========================================================
    -- 2. Validate wallet type
    -- ========================================================

    IF p_wallet_type NOT IN ('main', 'play') THEN

        RAISE EXCEPTION
            'Invalid wallet type. Use main or play';

    END IF;



    -- ========================================================
    -- 3. Validate amount
    -- ========================================================

    v_amount := ROUND(p_amount, 2);


    IF v_amount IS NULL
       OR v_amount <= 0
    THEN

        RAISE EXCEPTION
            'Transfer amount must be greater than zero';

    END IF;



    -- ========================================================
    -- 4. Validate idempotency key
    -- ========================================================

    IF p_idempotency_key IS NULL
       OR BTRIM(p_idempotency_key) = ''
    THEN

        RAISE EXCEPTION
            'Transfer idempotency key is required';

    END IF;



    -- ========================================================
    -- 5. Check existing transfer / idempotency
    -- ========================================================

    SELECT *
    INTO v_existing_transfer
    FROM public.transfers
    WHERE idempotency_key = p_idempotency_key
    FOR UPDATE;


    IF FOUND THEN

        IF v_existing_transfer.sender_user_id
               IS DISTINCT FROM p_sender_user_id

           OR v_existing_transfer.wallet_type
               IS DISTINCT FROM p_wallet_type

           OR v_existing_transfer.amount
               IS DISTINCT FROM v_amount

        THEN

            RAISE EXCEPTION
                'Idempotency key belongs to a different transfer';

        END IF;


        SELECT *
        INTO v_receiver
        FROM public.users
        WHERE id = v_existing_transfer.receiver_user_id;


        RETURN jsonb_build_object(

            'success',
            TRUE,

            'idempotent',
            TRUE,

            'transfer_id',
            v_existing_transfer.id,

            'transaction_id',
            v_existing_transfer.transaction_id,

            'sender_user_id',
            v_existing_transfer.sender_user_id,

            'receiver_user_id',
            v_existing_transfer.receiver_user_id,

            'receiver_telegram_id',
            v_receiver.telegram_id,

            'receiver_name',
            v_receiver.name,

            'wallet_type',
            v_existing_transfer.wallet_type,

            'amount',
            v_existing_transfer.amount,

            'status',
            v_existing_transfer.status

        );

    END IF;



    -- ========================================================
    -- 6. Normalize receiver phone
    -- ========================================================

    v_normalized_phone :=
        RIGHT(
            REGEXP_REPLACE(
                COALESCE(
                    p_receiver_phone,
                    ''
                ),
                '[^0-9]',
                '',
                'g'
            ),
            9
        );


    IF LENGTH(v_normalized_phone) <> 9 THEN

        RAISE EXCEPTION
            'Invalid receiver phone number';

    END IF;



    -- ========================================================
    -- 7. Find receiver
    -- ========================================================

    SELECT *
    INTO v_receiver
    FROM public.users
    WHERE RIGHT(
        REGEXP_REPLACE(
            COALESCE(phone, ''),
            '[^0-9]',
            '',
            'g'
        ),
        9
    ) = v_normalized_phone

      AND is_active = TRUE
      AND is_blocked = FALSE

    LIMIT 1
    FOR UPDATE;


    IF NOT FOUND THEN

        RAISE EXCEPTION
            'Receiver phone number is not registered or the account is unavailable';

    END IF;



    -- ========================================================
    -- 8. Prevent self transfer
    -- ========================================================

    IF v_receiver.id = v_sender.id THEN

        RAISE EXCEPTION
            'You cannot transfer money to yourself';

    END IF;



    -- ========================================================
    -- 9. Get wallet IDs
    -- ========================================================

    v_sender_wallet_id :=
        public.get_user_wallet_id(
            v_sender.id,
            p_wallet_type
        );


    v_receiver_wallet_id :=
        public.get_user_wallet_id(
            v_receiver.id,
            p_wallet_type
        );



    -- ========================================================
    -- 10. Lock wallets in deterministic order
    -- ========================================================

    IF v_sender_wallet_id < v_receiver_wallet_id THEN

        PERFORM public.lock_wallet(
            v_sender_wallet_id
        );

        PERFORM public.lock_wallet(
            v_receiver_wallet_id
        );

    ELSE

        PERFORM public.lock_wallet(
            v_receiver_wallet_id
        );

        PERFORM public.lock_wallet(
            v_sender_wallet_id
        );

    END IF;



    -- ========================================================
    -- 11. Read balances after wallet locking
    -- ========================================================

    SELECT balance
    INTO v_sender_balance
    FROM public.wallet_balances
    WHERE wallet_id = v_sender_wallet_id
    FOR UPDATE;


    SELECT balance
    INTO v_receiver_balance
    FROM public.wallet_balances
    WHERE wallet_id = v_receiver_wallet_id
    FOR UPDATE;


    IF v_sender_balance IS NULL THEN

        RAISE EXCEPTION
            'Sender wallet balance does not exist';

    END IF;


    IF v_receiver_balance IS NULL THEN

        RAISE EXCEPTION
            'Receiver wallet balance does not exist';

    END IF;



    -- ========================================================
    -- 12. Basic sufficient balance check
    -- ========================================================

    IF v_sender_balance < v_amount THEN

        RAISE EXCEPTION
            'Insufficient % wallet balance. Available: %, requested: %',
            p_wallet_type,
            v_sender_balance,
            v_amount;

    END IF;



    -- ========================================================
    -- 13. Get active DAILY transfer rule
    --
    -- This rule supplies:
    --
    -- minimum_transfer_amount
    -- maximum_transfer_amount
    -- minimum_remaining_balance
    --
    -- separately for main/play wallets.
    -- ========================================================

    v_rule :=
        public.get_active_transfer_rule(
            p_wallet_type,
            'daily'
        );


    IF v_rule.id IS NULL THEN

        RAISE EXCEPTION
            'No active transfer rule exists for % wallet',
            p_wallet_type;

    END IF;



    -- ========================================================
    -- 14. Minimum transfer amount
    -- ========================================================

    IF v_amount < v_rule.minimum_transfer_amount THEN

        RAISE EXCEPTION
            'Minimum % wallet transfer amount is %',
            p_wallet_type,
            v_rule.minimum_transfer_amount;

    END IF;



    -- ========================================================
    -- 15. Maximum amount per individual transfer
    -- ========================================================

    IF v_rule.maximum_transfer_amount IS NOT NULL
       AND v_amount > v_rule.maximum_transfer_amount
    THEN

        RAISE EXCEPTION
            'Maximum % wallet transfer amount per transfer is %',
            p_wallet_type,
            v_rule.maximum_transfer_amount;

    END IF;



    -- ========================================================
    -- 16. Minimum remaining sender balance
    --
    -- Example:
    --
    -- Sender balance       = 1000
    -- Minimum remaining    = 200
    -- Transfer              = 700
    -- Remaining             = 300
    --
    -- Allowed.
    --
    -- Transfer              = 850
    -- Remaining             = 150
    --
    -- Rejected.
    -- ========================================================

    v_remaining_balance :=
        ROUND(
            v_sender_balance - v_amount,
            2
        );


    IF v_remaining_balance <
       COALESCE(
           v_rule.minimum_remaining_balance,
           0
       )
    THEN

        RAISE EXCEPTION
            'Transfer would leave your % wallet below the required minimum remaining balance of %. Available balance: %, requested transfer: %, remaining balance would be: %',
            p_wallet_type,
            COALESCE(
                v_rule.minimum_remaining_balance,
                0
            ),
            v_sender_balance,
            v_amount,
            v_remaining_balance;

    END IF;



    -- ========================================================
    -- 17. DAILY limits
    -- ========================================================

    SELECT
        COUNT(*),
        COALESCE(
            SUM(amount),
            0
        )

    INTO
        v_daily_count,
        v_daily_amount

    FROM public.transfers

    WHERE sender_user_id = v_sender.id
      AND wallet_type = p_wallet_type
      AND status = 'completed'
      AND created_at >= date_trunc(
          'day',
          v_now
      );


    IF v_rule.maximum_transfer_count IS NOT NULL
       AND v_daily_count + 1 >
           v_rule.maximum_transfer_count
    THEN

        RAISE EXCEPTION
            'Daily transfer count limit reached: %',
            v_rule.maximum_transfer_count;

    END IF;


    IF v_rule.maximum_transfer_amount IS NOT NULL
       AND v_daily_amount + v_amount >
           v_rule.maximum_transfer_amount
    THEN

        RAISE EXCEPTION
            'Daily transfer amount limit reached. Remaining: %',
            GREATEST(
                v_rule.maximum_transfer_amount
                - v_daily_amount,
                0
            );

    END IF;



    -- ========================================================
    -- 18. WEEKLY limits
    -- ========================================================

    v_rule :=
        public.get_active_transfer_rule(
            p_wallet_type,
            'weekly'
        );


    IF v_rule.id IS NOT NULL THEN

        SELECT
            COUNT(*),
            COALESCE(
                SUM(amount),
                0
            )

        INTO
            v_weekly_count,
            v_weekly_amount

        FROM public.transfers

        WHERE sender_user_id = v_sender.id
          AND wallet_type = p_wallet_type
          AND status = 'completed'
          AND created_at >= date_trunc(
              'week',
              v_now
          );


        IF v_rule.maximum_transfer_count IS NOT NULL
           AND v_weekly_count + 1 >
               v_rule.maximum_transfer_count
        THEN

            RAISE EXCEPTION
                'Weekly transfer count limit reached: %',
                v_rule.maximum_transfer_count;

        END IF;


        IF v_rule.maximum_transfer_amount IS NOT NULL
           AND v_weekly_amount + v_amount >
               v_rule.maximum_transfer_amount
        THEN

            RAISE EXCEPTION
                'Weekly transfer amount limit reached. Remaining: %',
                GREATEST(
                    v_rule.maximum_transfer_amount
                    - v_weekly_amount,
                    0
                );

        END IF;

    END IF;



    -- ========================================================
    -- 19. MONTHLY limits
    -- ========================================================

    v_rule :=
        public.get_active_transfer_rule(
            p_wallet_type,
            'monthly'
        );


    IF v_rule.id IS NOT NULL THEN

        SELECT
            COUNT(*),
            COALESCE(
                SUM(amount),
                0
            )

        INTO
            v_monthly_count,
            v_monthly_amount

        FROM public.transfers

        WHERE sender_user_id = v_sender.id
          AND wallet_type = p_wallet_type
          AND status = 'completed'
          AND created_at >= date_trunc(
              'month',
              v_now
          );


        IF v_rule.maximum_transfer_count IS NOT NULL
           AND v_monthly_count + 1 >
               v_rule.maximum_transfer_count
        THEN

            RAISE EXCEPTION
                'Monthly transfer count limit reached: %',
                v_rule.maximum_transfer_count;

        END IF;


        IF v_rule.maximum_transfer_amount IS NOT NULL
           AND v_monthly_amount + v_amount >
               v_rule.maximum_transfer_amount
        THEN

            RAISE EXCEPTION
                'Monthly transfer amount limit reached. Remaining: %',
                GREATEST(
                    v_rule.maximum_transfer_amount
                    - v_monthly_amount,
                    0
                );

        END IF;

    END IF;



    -- ========================================================
    -- 20. QUARTERLY limits
    -- ========================================================

    v_rule :=
        public.get_active_transfer_rule(
            p_wallet_type,
            'quarterly'
        );


    IF v_rule.id IS NOT NULL THEN

        SELECT
            COUNT(*),
            COALESCE(
                SUM(amount),
                0
            )

        INTO
            v_quarterly_count,
            v_quarterly_amount

        FROM public.transfers

        WHERE sender_user_id = v_sender.id
          AND wallet_type = p_wallet_type
          AND status = 'completed'
          AND created_at >= date_trunc(
              'quarter',
              v_now
          );


        IF v_rule.maximum_transfer_count IS NOT NULL
           AND v_quarterly_count + 1 >
               v_rule.maximum_transfer_count
        THEN

            RAISE EXCEPTION
                'Quarterly transfer count limit reached: %',
                v_rule.maximum_transfer_count;

        END IF;


        IF v_rule.maximum_transfer_amount IS NOT NULL
           AND v_quarterly_amount + v_amount >
               v_rule.maximum_transfer_amount
        THEN

            RAISE EXCEPTION
                'Quarterly transfer amount limit reached. Remaining: %',
                GREATEST(
                    v_rule.maximum_transfer_amount
                    - v_quarterly_amount,
                    0
                );

        END IF;

    END IF;



    -- ========================================================
    -- 21. YEARLY limits
    -- ========================================================

    v_rule :=
        public.get_active_transfer_rule(
            p_wallet_type,
            'yearly'
        );


    IF v_rule.id IS NOT NULL THEN

        SELECT
            COUNT(*),
            COALESCE(
                SUM(amount),
                0
            )

        INTO
            v_yearly_count,
            v_yearly_amount

        FROM public.transfers

        WHERE sender_user_id = v_sender.id
          AND wallet_type = p_wallet_type
          AND status = 'completed'
          AND created_at >= date_trunc(
              'year',
              v_now
          );


        IF v_rule.maximum_transfer_count IS NOT NULL
           AND v_yearly_count + 1 >
               v_rule.maximum_transfer_count
        THEN

            RAISE EXCEPTION
                'Yearly transfer count limit reached: %',
                v_rule.maximum_transfer_count;

        END IF;


        IF v_rule.maximum_transfer_amount IS NOT NULL
           AND v_yearly_amount + v_amount >
               v_rule.maximum_transfer_amount
        THEN

            RAISE EXCEPTION
                'Yearly transfer amount limit reached. Remaining: %',
                GREATEST(
                    v_rule.maximum_transfer_amount
                    - v_yearly_amount,
                    0
                );

        END IF;

    END IF;



    -- ========================================================
    -- 22. Create financial transaction
    -- ========================================================

    SELECT
        t.transaction_id,
        t.created

    INTO
        v_transaction_id,
        v_transaction_created

    FROM public.create_financial_transaction(
        v_sender.id,
        'transfer',
        'completed',
        NULL,
        'wallet_transfer',
        p_idempotency_key,
        p_idempotency_key,
        COALESCE(
            p_description,
            'Wallet transfer'
        ),
        jsonb_build_object(

            'sender_user_id',
            v_sender.id,

            'receiver_user_id',
            v_receiver.id,

            'wallet_type',
            p_wallet_type,

            'amount',
            v_amount,

            'receiver_phone',
            v_receiver.phone

        )
    ) AS t;



    -- ========================================================
    -- 23. Idempotent retry
    -- ========================================================

    IF NOT v_transaction_created THEN

        SELECT id
        INTO v_transfer_id

        FROM public.transfers

        WHERE transaction_id =
            v_transaction_id

        LIMIT 1;


        IF v_transfer_id IS NULL THEN

            RAISE EXCEPTION
                'Financial transaction exists but transfer record is missing';

        END IF;


        SELECT *
        INTO v_receiver

        FROM public.users

        WHERE id = (
            SELECT receiver_user_id
            FROM public.transfers
            WHERE id = v_transfer_id
        );


        RETURN jsonb_build_object(

            'success',
            TRUE,

            'idempotent',
            TRUE,

            'transfer_id',
            v_transfer_id,

            'transaction_id',
            v_transaction_id,

            'sender_user_id',
            v_sender.id,

            'receiver_user_id',
            v_receiver.id,

            'receiver_telegram_id',
            v_receiver.telegram_id,

            'receiver_name',
            v_receiver.name,

            'amount',
            v_amount,

            'wallet_type',
            p_wallet_type

        );

    END IF;



    -- ========================================================
    -- 24. Debit sender wallet
    -- ========================================================

    INSERT INTO public.ledger_entries (
        transaction_id,
        wallet_id,
        amount
    )
    VALUES (
        v_transaction_id,
        v_sender_wallet_id,
        -v_amount
    );


    UPDATE public.wallet_balances

    SET
        balance = balance - v_amount,
        updated_at = NOW()

    WHERE wallet_id = v_sender_wallet_id;



    -- ========================================================
    -- 25. Credit receiver wallet
    -- ========================================================

    INSERT INTO public.ledger_entries (
        transaction_id,
        wallet_id,
        amount
    )
    VALUES (
        v_transaction_id,
        v_receiver_wallet_id,
        v_amount
    );


    UPDATE public.wallet_balances

    SET
        balance = balance + v_amount,
        updated_at = NOW()

    WHERE wallet_id = v_receiver_wallet_id;



    -- ========================================================
    -- 26. Create transfer record
    -- ========================================================

    INSERT INTO public.transfers (
        transaction_id,
        sender_user_id,
        receiver_user_id,
        amount,
        wallet_type,
        rule_id,
        idempotency_key,
        status,
        metadata,
        created_at
    )

    VALUES (

        v_transaction_id,

        v_sender.id,

        v_receiver.id,

        v_amount,

        p_wallet_type,

        v_rule.id,

        p_idempotency_key,

        'completed',

        jsonb_build_object(

            'sender_phone',
            v_sender.phone,

            'receiver_phone',
            v_receiver.phone,

            'wallet_type',
            p_wallet_type

        ),

        v_now

    )

    RETURNING id
    INTO v_transfer_id;



    -- ========================================================
    -- 27. Final consistency checks
    -- ========================================================

    IF NOT EXISTS (

        SELECT 1

        FROM public.ledger_entries

        WHERE transaction_id =
            v_transaction_id

          AND wallet_id =
              v_sender_wallet_id

          AND amount =
              -v_amount

    ) THEN

        RAISE EXCEPTION
            'Sender ledger entry was not created';

    END IF;



    IF NOT EXISTS (

        SELECT 1

        FROM public.ledger_entries

        WHERE transaction_id =
            v_transaction_id

          AND wallet_id =
              v_receiver_wallet_id

          AND amount =
              v_amount

    ) THEN

        RAISE EXCEPTION
            'Receiver ledger entry was not created';

    END IF;



    -- ========================================================
    -- 28. Final return
    -- ========================================================

    RETURN jsonb_build_object(

        'success',
        TRUE,

        'idempotent',
        FALSE,

        'transfer_id',
        v_transfer_id,

        'transaction_id',
        v_transaction_id,

        'sender_user_id',
        v_sender.id,

        'sender_name',
        v_sender.name,

        'receiver_user_id',
        v_receiver.id,

        'receiver_telegram_id',
        v_receiver.telegram_id,

        'receiver_name',
        v_receiver.name,

        'wallet_type',
        p_wallet_type,

        'amount',
        v_amount,

        'sender_balance_before',
        v_sender_balance,

        'sender_balance_after',
        v_remaining_balance,

        'receiver_balance_before',
        v_receiver_balance,

        'receiver_balance_after',
        ROUND(
            v_receiver_balance + v_amount,
            2
        ),

        'minimum_remaining_balance',
        COALESCE(
            (
                SELECT minimum_remaining_balance
                FROM public.transfer_rules
                WHERE id = v_rule.id
            ),
            0
        ),

        'status',
        'completed'

    );

END;

$$;


ALTER FUNCTION public.transfer_wallet(p_sender_user_id integer, p_receiver_phone character varying, p_wallet_type character varying, p_amount numeric, p_idempotency_key character varying, p_description text) OWNER TO neondb_owner;

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
-- Name: bingo_commission_rules; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.bingo_commission_rules (
    id bigint NOT NULL,
    name character varying(100) NOT NULL,
    code character varying(50) NOT NULL,
    commission_rate numeric(7,4) NOT NULL,
    stake_id character varying(10),
    room_id bigint,
    priority integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    starts_at timestamp with time zone,
    ends_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bingo_commission_rules_dates_check CHECK (((starts_at IS NULL) OR (ends_at IS NULL) OR (starts_at <= ends_at))),
    CONSTRAINT bingo_commission_rules_priority_check CHECK ((priority >= 0)),
    CONSTRAINT bingo_commission_rules_rate_check CHECK (((commission_rate >= (0)::numeric) AND (commission_rate <= (100)::numeric)))
);


ALTER TABLE public.bingo_commission_rules OWNER TO neondb_owner;

--
-- Name: bingo_commission_rules_id_seq; Type: SEQUENCE; Schema: public; Owner: neondb_owner
--

ALTER TABLE public.bingo_commission_rules ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.bingo_commission_rules_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: bingo_games; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.bingo_games (
    id bigint NOT NULL,
    game_code character varying(32) NOT NULL,
    room_id bigint NOT NULL,
    stake_id character varying(10) NOT NULL,
    stake_amount numeric(18,2) NOT NULL,
    commission_rule_id bigint NOT NULL,
    commission_rate numeric(7,4) NOT NULL,
    gross_pot numeric(18,2) DEFAULT 0 NOT NULL,
    commission_amount numeric(18,2) DEFAULT 0 NOT NULL,
    prize_pool numeric(18,2) DEFAULT 0 NOT NULL,
    status character varying(20) DEFAULT 'waiting'::character varying NOT NULL,
    called_numbers integer[] DEFAULT '{}'::integer[] NOT NULL,
    is_split boolean DEFAULT false NOT NULL,
    selection_started_at timestamp with time zone,
    selection_ends_at timestamp with time zone,
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    card_count integer NOT NULL,
    max_cards_per_player integer NOT NULL,
    idempotency_key character varying(150),
    CONSTRAINT bingo_games_commission_amount_check CHECK ((commission_amount >= (0)::numeric)),
    CONSTRAINT bingo_games_commission_rate_check CHECK (((commission_rate >= (0)::numeric) AND (commission_rate <= (100)::numeric))),
    CONSTRAINT bingo_games_financial_equation_check CHECK (((commission_amount + prize_pool) = gross_pot)),
    CONSTRAINT bingo_games_gross_pot_check CHECK ((gross_pot >= (0)::numeric)),
    CONSTRAINT bingo_games_prize_pool_check CHECK ((prize_pool >= (0)::numeric)),
    CONSTRAINT bingo_games_selection_time_check CHECK (((selection_ends_at IS NULL) OR (selection_started_at IS NULL) OR (selection_ends_at >= selection_started_at))),
    CONSTRAINT bingo_games_stake_amount_check CHECK ((stake_amount > (0)::numeric)),
    CONSTRAINT bingo_games_start_time_check CHECK (((ended_at IS NULL) OR (started_at IS NULL) OR (ended_at >= started_at))),
    CONSTRAINT bingo_games_status_check CHECK (((status)::text = ANY ((ARRAY['waiting'::character varying, 'selection'::character varying, 'playing'::character varying, 'completed'::character varying, 'cancelled'::character varying])::text[])))
);


ALTER TABLE public.bingo_games OWNER TO neondb_owner;

--
-- Name: bingo_games_id_seq; Type: SEQUENCE; Schema: public; Owner: neondb_owner
--

ALTER TABLE public.bingo_games ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.bingo_games_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: bingo_participant_cards; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.bingo_participant_cards (
    id bigint NOT NULL,
    participant_id bigint NOT NULL,
    game_id integer NOT NULL,
    card_id integer NOT NULL,
    card_data jsonb NOT NULL,
    transaction_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_disqualified boolean DEFAULT false NOT NULL,
    CONSTRAINT bingo_participant_cards_card_id_check CHECK ((card_id >= 1))
);


ALTER TABLE public.bingo_participant_cards OWNER TO neondb_owner;

--
-- Name: bingo_participant_cards_id_seq; Type: SEQUENCE; Schema: public; Owner: neondb_owner
--

ALTER TABLE public.bingo_participant_cards ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.bingo_participant_cards_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: bingo_participants; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.bingo_participants (
    id bigint NOT NULL,
    game_id integer NOT NULL,
    user_id integer NOT NULL,
    amount_paid numeric(18,2) NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    is_disqualified boolean DEFAULT false NOT NULL,
    amount_won numeric(18,2) DEFAULT 0 NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    bingo_mode_override character varying(20),
    bingo_mode character varying(10) DEFAULT 'auto'::character varying,
    CONSTRAINT bingo_participants_amount_paid_check CHECK ((amount_paid > (0)::numeric)),
    CONSTRAINT bingo_participants_amount_won_check CHECK ((amount_won >= (0)::numeric)),
    CONSTRAINT bingo_participants_bingo_mode_check CHECK (((bingo_mode IS NULL) OR ((bingo_mode)::text = ANY ((ARRAY['auto'::character varying, 'manual'::character varying])::text[])))),
    CONSTRAINT bingo_participants_bingo_mode_override_check CHECK (((bingo_mode_override IS NULL) OR ((bingo_mode_override)::text = ANY ((ARRAY['auto'::character varying, 'manual'::character varying])::text[])))),
    CONSTRAINT bingo_participants_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'completed'::character varying, 'cancelled'::character varying, 'refunded'::character varying])::text[])))
);


ALTER TABLE public.bingo_participants OWNER TO neondb_owner;

--
-- Name: bingo_participants_id_seq; Type: SEQUENCE; Schema: public; Owner: neondb_owner
--

ALTER TABLE public.bingo_participants ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.bingo_participants_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: bingo_room_stakes; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.bingo_room_stakes (
    room_id bigint NOT NULL,
    stake_id character varying(10) NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bingo_room_stakes_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'inactive'::character varying])::text[])))
);


ALTER TABLE public.bingo_room_stakes OWNER TO neondb_owner;

--
-- Name: bingo_rooms; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.bingo_rooms (
    id bigint NOT NULL,
    name character varying(100) NOT NULL,
    code character varying(30) NOT NULL,
    description text,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    min_players integer DEFAULT 2 NOT NULL,
    max_players integer,
    card_count integer DEFAULT 400 NOT NULL,
    max_cards_per_player integer DEFAULT 2 NOT NULL,
    selection_seconds integer DEFAULT 50 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    disqualification_policy character varying(30) DEFAULT 'exclude_card'::character varying NOT NULL,
    bingo_mode_policy character varying(20) DEFAULT 'choice'::character varying NOT NULL,
    bingo_button_scope character varying(20) DEFAULT 'all_cards'::character varying NOT NULL,
    commission_rule_id bigint NOT NULL,
    CONSTRAINT bingo_rooms_bingo_button_scope_check CHECK (((bingo_button_scope)::text = ANY ((ARRAY['all_cards'::character varying, 'per_card'::character varying])::text[]))),
    CONSTRAINT bingo_rooms_bingo_mode_policy_check CHECK (((bingo_mode_policy)::text = ANY ((ARRAY['choice'::character varying, 'auto_only'::character varying, 'manual_only'::character varying])::text[]))),
    CONSTRAINT bingo_rooms_card_count_check CHECK ((card_count >= 1)),
    CONSTRAINT bingo_rooms_disqualification_policy_check CHECK (((disqualification_policy)::text = ANY ((ARRAY['exclude_card'::character varying, 'exclude_participant'::character varying, 'include'::character varying])::text[]))),
    CONSTRAINT bingo_rooms_max_cards_per_player_check CHECK (((max_cards_per_player >= 1) AND (max_cards_per_player <= card_count))),
    CONSTRAINT bingo_rooms_max_players_check CHECK (((max_players IS NULL) OR (max_players >= min_players))),
    CONSTRAINT bingo_rooms_min_players_check CHECK ((min_players >= 2)),
    CONSTRAINT bingo_rooms_selection_seconds_check CHECK ((selection_seconds >= 10)),
    CONSTRAINT bingo_rooms_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'inactive'::character varying, 'maintenance'::character varying])::text[])))
);


ALTER TABLE public.bingo_rooms OWNER TO neondb_owner;

--
-- Name: bingo_rooms_id_seq; Type: SEQUENCE; Schema: public; Owner: neondb_owner
--

ALTER TABLE public.bingo_rooms ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.bingo_rooms_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: bingo_stakes; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.bingo_stakes (
    id character varying(10) NOT NULL,
    name character varying(100) NOT NULL,
    amount numeric(18,2) NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    display_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    display_name character varying(20) NOT NULL,
    CONSTRAINT bingo_stakes_amount_positive CHECK ((amount > (0)::numeric)),
    CONSTRAINT bingo_stakes_display_order_check CHECK ((display_order >= 0))
);


ALTER TABLE public.bingo_stakes OWNER TO neondb_owner;

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
    CONSTRAINT bingo_winners_card_id_check CHECK ((card_id >= 1)),
    CONSTRAINT bingo_winners_payout_check CHECK ((payout > (0)::numeric))
);


ALTER TABLE public.bingo_winners OWNER TO neondb_owner;

--
-- Name: bingo_winners_id_seq; Type: SEQUENCE; Schema: public; Owner: neondb_owner
--

ALTER TABLE public.bingo_winners ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.bingo_winners_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: bonus_campaigns; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.bonus_campaigns (
    id bigint NOT NULL,
    code character varying(100) NOT NULL,
    name character varying(150) NOT NULL,
    bonus_type character varying(50) NOT NULL,
    game_system_id bigint,
    amount numeric(18,2),
    percentage numeric(8,4),
    wagering_multiplier numeric(10,2) DEFAULT 0 NOT NULL,
    min_deposit_amount numeric(18,2),
    max_bonus_amount numeric(18,2),
    validity_hours integer,
    is_active boolean DEFAULT true NOT NULL,
    starts_at timestamp with time zone,
    ends_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    conversion_type character varying(30) DEFAULT 'none'::character varying NOT NULL,
    conversion_percentage numeric(8,4) DEFAULT 100 NOT NULL,
    conversion_max_amount numeric(18,2),
    multiplier numeric(18,4),
    stackable boolean DEFAULT false NOT NULL,
    stack_group character varying(50),
    priority integer DEFAULT 0 NOT NULL,
    conversion_amount numeric(18,2),
    CONSTRAINT bonus_campaigns_amount_check CHECK (((amount IS NULL) OR (amount >= (0)::numeric))),
    CONSTRAINT bonus_campaigns_bonus_type_check CHECK (((bonus_type)::text = ANY ((ARRAY['welcome'::character varying, 'deposit'::character varying, 'free_bet'::character varying, 'no_deposit'::character varying, 'reload'::character varying, 'cashback'::character varying, 'free_spins'::character varying, 'wagering'::character varying, 'odds_boost'::character varying, 'accumulator'::character varying, 'loyalty'::character varying, 'vip_tier'::character varying, 'referral'::character varying, 'promo_code'::character varying, 'tournament'::character varying, 'mission'::character varying, 'birthday'::character varying, 'free_entry'::character varying, 'insurance'::character varying, 'jackpot'::character varying])::text[]))),
    CONSTRAINT bonus_campaigns_calculation_rule_check CHECK ((((multiplier IS NOT NULL) AND (amount IS NULL) AND (percentage IS NULL)) OR ((multiplier IS NULL) AND (amount IS NOT NULL) AND (percentage IS NULL)) OR ((multiplier IS NULL) AND (amount IS NULL) AND (percentage IS NOT NULL)))),
    CONSTRAINT bonus_campaigns_conversion_amount_check CHECK (((conversion_amount IS NULL) OR (conversion_amount >= (0)::numeric))),
    CONSTRAINT bonus_campaigns_conversion_max_amount_check CHECK (((conversion_max_amount IS NULL) OR (conversion_max_amount >= (0)::numeric))),
    CONSTRAINT bonus_campaigns_conversion_percentage_check CHECK (((conversion_percentage >= (0)::numeric) AND (conversion_percentage <= (100)::numeric))),
    CONSTRAINT bonus_campaigns_conversion_type_check CHECK (((conversion_type)::text = ANY ((ARRAY['percentage'::character varying, 'fixed'::character varying, 'none'::character varying])::text[]))),
    CONSTRAINT bonus_campaigns_date_check CHECK (((ends_at IS NULL) OR (starts_at IS NULL) OR (ends_at > starts_at))),
    CONSTRAINT bonus_campaigns_max_bonus_amount_check CHECK (((max_bonus_amount IS NULL) OR (max_bonus_amount >= (0)::numeric))),
    CONSTRAINT bonus_campaigns_metadata_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT bonus_campaigns_min_deposit_amount_check CHECK (((min_deposit_amount IS NULL) OR (min_deposit_amount >= (0)::numeric))),
    CONSTRAINT bonus_campaigns_multiplier_check CHECK (((multiplier IS NULL) OR (multiplier >= (0)::numeric))),
    CONSTRAINT bonus_campaigns_percentage_check CHECK (((percentage IS NULL) OR ((percentage >= (0)::numeric) AND (percentage <= (100)::numeric)))),
    CONSTRAINT bonus_campaigns_priority_check CHECK ((priority >= 0)),
    CONSTRAINT bonus_campaigns_stack_group_check CHECK (((stack_group IS NULL) OR (length(btrim((stack_group)::text)) > 0))),
    CONSTRAINT bonus_campaigns_validity_hours_check CHECK (((validity_hours IS NULL) OR (validity_hours > 0))),
    CONSTRAINT bonus_campaigns_wagering_multiplier_check CHECK ((wagering_multiplier >= (0)::numeric))
);


ALTER TABLE public.bonus_campaigns OWNER TO neondb_owner;

--
-- Name: bonus_campaigns_id_seq; Type: SEQUENCE; Schema: public; Owner: neondb_owner
--

CREATE SEQUENCE public.bonus_campaigns_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.bonus_campaigns_id_seq OWNER TO neondb_owner;

--
-- Name: bonus_campaigns_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: neondb_owner
--

ALTER SEQUENCE public.bonus_campaigns_id_seq OWNED BY public.bonus_campaigns.id;


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
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
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
    game_code_prefix character varying(20),
    game_code_suffix character varying(20),
    game_code_type character varying(30),
    game_code_length integer,
    game_code_sequence bigint DEFAULT 0 NOT NULL,
    CONSTRAINT game_systems_game_code_length_check CHECK (((game_code_length IS NULL) OR (game_code_length > 0))),
    CONSTRAINT game_systems_game_code_type_check CHECK (((game_code_type IS NULL) OR ((game_code_type)::text = ANY ((ARRAY['sequential_numbers'::character varying, 'random_numbers'::character varying, 'random_alphabets'::character varying, 'sequential_alphabets'::character varying, 'alphanumeric'::character varying, 'random_alphanumeric'::character varying])::text[])))),
    CONSTRAINT game_systems_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'inactive'::character varying, 'maintenance'::character varying, 'disabled'::character varying])::text[])))
);

-- ============================================================
-- SEED: Bingo game system
-- ============================================================

INSERT INTO public.game_systems (
    code,
    name,
    status,
    metadata,
	game_code_prefix,
	game_code_suffix,
	game_code_type,
	game_code_length,
	game_code_sequence
)
VALUES (
    'bingo',
    'Bingo',
    'active',
    '{"source_type":"bingo_game"}'::jsonb,
	'BG-',
	'',
	'random_alphanumeric',
	8,
	0
)
ON CONFLICT (code)
DO UPDATE SET
    name = EXCLUDED.name,
    status = EXCLUDED.status,
    metadata = EXCLUDED.metadata,
    updated_at = NOW();


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
-- Name: stake_funding_policies_id_seq; Type: SEQUENCE; Schema: public; Owner: neondb_owner
--

CREATE SEQUENCE public.stake_funding_policies_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.stake_funding_policies_id_seq OWNER TO neondb_owner;

--
-- Name: stake_funding_policies_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: neondb_owner
--

ALTER SEQUENCE public.stake_funding_policies_id_seq OWNED BY public.stake_funding_policies.id;


--
-- Name: stake_funding_policy_overview; Type: VIEW; Schema: public; Owner: neondb_owner
--

CREATE VIEW public.stake_funding_policy_overview AS
 SELECT gs.id AS game_system_id,
    gs.code AS game_system_code,
    gs.name AS game_system_name,
    sfp.id AS policy_id,
    sfp.policy_code,
    sfp.is_active,
    sfp.priority,
    sfp.starts_at,
    sfp.ends_at,
    sfp.description
   FROM (public.game_systems gs
     LEFT JOIN public.stake_funding_policies sfp ON (((sfp.game_system_id = gs.id) AND (sfp.is_active = true))));


ALTER VIEW public.stake_funding_policy_overview OWNER TO neondb_owner;

--
-- Name: stake_funding_policy_wallets; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.stake_funding_policy_wallets (
    id bigint NOT NULL,
    policy_id bigint NOT NULL,
    wallet_type character varying(30) NOT NULL,
    funding_order integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT stake_funding_policy_wallets_metadata_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT stake_funding_policy_wallets_order_check CHECK ((funding_order > 0)),
    CONSTRAINT stake_funding_policy_wallets_wallet_type_check CHECK (((wallet_type)::text = ANY ((ARRAY['main'::character varying, 'play'::character varying, 'bonus'::character varying])::text[])))
);


ALTER TABLE public.stake_funding_policy_wallets OWNER TO neondb_owner;

--
-- Name: stake_funding_policy_wallets_id_seq; Type: SEQUENCE; Schema: public; Owner: neondb_owner
--

CREATE SEQUENCE public.stake_funding_policy_wallets_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.stake_funding_policy_wallets_id_seq OWNER TO neondb_owner;

--
-- Name: stake_funding_policy_wallets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: neondb_owner
--

ALTER SEQUENCE public.stake_funding_policy_wallets_id_seq OWNED BY public.stake_funding_policy_wallets.id;


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
-- Name: transfer_rules_id_seq; Type: SEQUENCE; Schema: public; Owner: neondb_owner
--

ALTER TABLE public.transfer_rules ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.transfer_rules_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: transfers; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.transfers (
    id bigint NOT NULL,
    transaction_id bigint NOT NULL,
    sender_user_id integer NOT NULL,
    receiver_user_id integer NOT NULL,
    wallet_type character varying(20) NOT NULL,
    amount numeric(18,2) NOT NULL,
    rule_id bigint,
    status character varying(20) DEFAULT 'completed'::character varying NOT NULL,
    idempotency_key character varying(150),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT transfers_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT transfers_different_users_check CHECK ((sender_user_id <> receiver_user_id)),
    CONSTRAINT transfers_idempotency_key_check CHECK (((idempotency_key IS NULL) OR (length(btrim((idempotency_key)::text)) > 0))),
    CONSTRAINT transfers_metadata_object_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT transfers_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'completed'::character varying, 'failed'::character varying, 'cancelled'::character varying, 'reversed'::character varying])::text[]))),
    CONSTRAINT transfers_updated_at_check CHECK ((updated_at >= created_at)),
    CONSTRAINT transfers_wallet_type_check CHECK (((wallet_type)::text = ANY ((ARRAY['main'::character varying, 'play'::character varying])::text[])))
);


ALTER TABLE public.transfers OWNER TO neondb_owner;

--
-- Name: transfers_id_seq; Type: SEQUENCE; Schema: public; Owner: neondb_owner
--

ALTER TABLE public.transfers ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.transfers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: user_bonus_consumptions; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.user_bonus_consumptions (
    id bigint NOT NULL,
    user_bonus_id bigint NOT NULL,
    stake_transaction_id bigint NOT NULL,
    amount numeric(18,2) NOT NULL,
    wagering_amount numeric(18,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_bonus_consumptions_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT user_bonus_consumptions_wagering_amount_check CHECK ((wagering_amount >= (0)::numeric))
);


ALTER TABLE public.user_bonus_consumptions OWNER TO neondb_owner;

--
-- Name: user_bonus_consumptions_id_seq; Type: SEQUENCE; Schema: public; Owner: neondb_owner
--

CREATE SEQUENCE public.user_bonus_consumptions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.user_bonus_consumptions_id_seq OWNER TO neondb_owner;

--
-- Name: user_bonus_consumptions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: neondb_owner
--

ALTER SEQUENCE public.user_bonus_consumptions_id_seq OWNED BY public.user_bonus_consumptions.id;


--
-- Name: user_bonuses; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.user_bonuses (
    id bigint NOT NULL,
    user_id integer NOT NULL,
    campaign_id bigint NOT NULL,
    status character varying(30) DEFAULT 'pending'::character varying NOT NULL,
    awarded_amount numeric(18,2) DEFAULT 0 NOT NULL,
    wagering_requirement numeric(18,2) DEFAULT 0 NOT NULL,
    wagering_progress numeric(18,2) DEFAULT 0 NOT NULL,
    remaining_amount numeric(18,2) DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone,
    awarded_at timestamp with time zone,
    activated_at timestamp with time zone,
    completed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    source_type character varying(50),
    source_id character varying(100),
    idempotency_key character varying(255),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    convertible_amount numeric(18,2) DEFAULT 0 NOT NULL,
    converted_amount numeric(18,2) DEFAULT 0 NOT NULL,
    CONSTRAINT user_bonuses_awarded_amount_check CHECK ((awarded_amount >= (0)::numeric)),
    CONSTRAINT user_bonuses_converted_amount_check CHECK ((converted_amount >= (0)::numeric)),
    CONSTRAINT user_bonuses_convertible_amount_check CHECK ((convertible_amount >= (0)::numeric)),
    CONSTRAINT user_bonuses_metadata_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT user_bonuses_remaining_amount_check CHECK ((remaining_amount >= (0)::numeric)),
    CONSTRAINT user_bonuses_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'active'::character varying, 'completed'::character varying, 'expired'::character varying, 'cancelled'::character varying, 'forfeited'::character varying])::text[]))),
    CONSTRAINT user_bonuses_wagering_progress_check CHECK ((wagering_progress >= (0)::numeric)),
    CONSTRAINT user_bonuses_wagering_requirement_check CHECK ((wagering_requirement >= (0)::numeric))
);


ALTER TABLE public.user_bonuses OWNER TO neondb_owner;

--
-- Name: user_bonuses_id_seq; Type: SEQUENCE; Schema: public; Owner: neondb_owner
--

CREATE SEQUENCE public.user_bonuses_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.user_bonuses_id_seq OWNER TO neondb_owner;

--
-- Name: user_bonuses_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: neondb_owner
--

ALTER SEQUENCE public.user_bonuses_id_seq OWNED BY public.user_bonuses.id;


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
-- Name: vip_tiers; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.vip_tiers (
    id bigint NOT NULL,
    code character varying(50) NOT NULL,
    name character varying(100) NOT NULL,
    level integer NOT NULL,
    min_lifetime_deposit numeric(18,2) DEFAULT 0 NOT NULL,
    min_lifetime_wager numeric(18,2) DEFAULT 0 NOT NULL,
    deposit_bonus_percentage numeric(8,4) DEFAULT 0,
    is_active boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vip_tiers_bonus_percentage_check CHECK (((deposit_bonus_percentage >= (0)::numeric) AND (deposit_bonus_percentage <= (100)::numeric))),
    CONSTRAINT vip_tiers_level_check CHECK ((level > 0)),
    CONSTRAINT vip_tiers_min_deposit_check CHECK ((min_lifetime_deposit >= (0)::numeric)),
    CONSTRAINT vip_tiers_min_wager_check CHECK ((min_lifetime_wager >= (0)::numeric))
);


ALTER TABLE public.vip_tiers OWNER TO neondb_owner;

--
-- Name: vip_tiers_id_seq; Type: SEQUENCE; Schema: public; Owner: neondb_owner
--

CREATE SEQUENCE public.vip_tiers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.vip_tiers_id_seq OWNER TO neondb_owner;

--
-- Name: vip_tiers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: neondb_owner
--

ALTER SEQUENCE public.vip_tiers_id_seq OWNED BY public.vip_tiers.id;


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
-- Name: bonus_campaigns id; Type: DEFAULT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bonus_campaigns ALTER COLUMN id SET DEFAULT nextval('public.bonus_campaigns_id_seq'::regclass);


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
-- Name: stake_funding_policies id; Type: DEFAULT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.stake_funding_policies ALTER COLUMN id SET DEFAULT nextval('public.stake_funding_policies_id_seq'::regclass);


--
-- Name: stake_funding_policy_wallets id; Type: DEFAULT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.stake_funding_policy_wallets ALTER COLUMN id SET DEFAULT nextval('public.stake_funding_policy_wallets_id_seq'::regclass);


--
-- Name: user_bonus_consumptions id; Type: DEFAULT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.user_bonus_consumptions ALTER COLUMN id SET DEFAULT nextval('public.user_bonus_consumptions_id_seq'::regclass);


--
-- Name: user_bonuses id; Type: DEFAULT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.user_bonuses ALTER COLUMN id SET DEFAULT nextval('public.user_bonuses_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: vip_tiers id; Type: DEFAULT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.vip_tiers ALTER COLUMN id SET DEFAULT nextval('public.vip_tiers_id_seq'::regclass);


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
-- Name: bingo_commission_rules bingo_commission_rules_code_unique; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_commission_rules
    ADD CONSTRAINT bingo_commission_rules_code_unique UNIQUE (code);


--
-- Name: bingo_commission_rules bingo_commission_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_commission_rules
    ADD CONSTRAINT bingo_commission_rules_pkey PRIMARY KEY (id);


--
-- Name: bingo_games bingo_games_code_unique; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_games
    ADD CONSTRAINT bingo_games_code_unique UNIQUE (game_code);


--
-- Name: bingo_games bingo_games_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_games
    ADD CONSTRAINT bingo_games_pkey PRIMARY KEY (id);


--
-- Name: bingo_participant_cards bingo_participant_cards_game_card_unique; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_participant_cards
    ADD CONSTRAINT bingo_participant_cards_game_card_unique UNIQUE (game_id, card_id);


--
-- Name: bingo_participant_cards bingo_participant_cards_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_participant_cards
    ADD CONSTRAINT bingo_participant_cards_pkey PRIMARY KEY (id);


--
-- Name: bingo_participants bingo_participants_game_user_unique; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_participants
    ADD CONSTRAINT bingo_participants_game_user_unique UNIQUE (game_id, user_id);


--
-- Name: bingo_participants bingo_participants_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_participants
    ADD CONSTRAINT bingo_participants_pkey PRIMARY KEY (id);


--
-- Name: bingo_room_stakes bingo_room_stakes_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_room_stakes
    ADD CONSTRAINT bingo_room_stakes_pkey PRIMARY KEY (room_id, stake_id);


--
-- Name: bingo_rooms bingo_rooms_code_unique; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_rooms
    ADD CONSTRAINT bingo_rooms_code_unique UNIQUE (code);


--
-- Name: bingo_rooms bingo_rooms_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_rooms
    ADD CONSTRAINT bingo_rooms_pkey PRIMARY KEY (id);


--
-- Name: bingo_stakes bingo_stakes_name_unique; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_stakes
    ADD CONSTRAINT bingo_stakes_name_unique UNIQUE (name);


--
-- Name: bingo_stakes bingo_stakes_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_stakes
    ADD CONSTRAINT bingo_stakes_pkey PRIMARY KEY (id);


--
-- Name: bingo_winners bingo_winners_game_card_unique; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_winners
    ADD CONSTRAINT bingo_winners_game_card_unique UNIQUE (game_id, card_id);


--
-- Name: bingo_winners bingo_winners_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_winners
    ADD CONSTRAINT bingo_winners_pkey PRIMARY KEY (id);


--
-- Name: bonus_campaigns bonus_campaigns_code_key; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bonus_campaigns
    ADD CONSTRAINT bonus_campaigns_code_key UNIQUE (code);


--
-- Name: bonus_campaigns bonus_campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bonus_campaigns
    ADD CONSTRAINT bonus_campaigns_pkey PRIMARY KEY (id);


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
-- Name: stake_funding_policies stake_funding_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.stake_funding_policies
    ADD CONSTRAINT stake_funding_policies_pkey PRIMARY KEY (id);


--
-- Name: stake_funding_policy_wallets stake_funding_policy_wallets_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.stake_funding_policy_wallets
    ADD CONSTRAINT stake_funding_policy_wallets_pkey PRIMARY KEY (id);


--
-- Name: stake_funding_policy_wallets stake_funding_policy_wallets_unique_order; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.stake_funding_policy_wallets
    ADD CONSTRAINT stake_funding_policy_wallets_unique_order UNIQUE (policy_id, funding_order);


--
-- Name: stake_funding_policy_wallets stake_funding_policy_wallets_unique_wallet; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.stake_funding_policy_wallets
    ADD CONSTRAINT stake_funding_policy_wallets_unique_wallet UNIQUE (policy_id, wallet_type);


--
-- Name: transfer_rules transfer_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.transfer_rules
    ADD CONSTRAINT transfer_rules_pkey PRIMARY KEY (id);


--
-- Name: transfers transfers_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.transfers
    ADD CONSTRAINT transfers_pkey PRIMARY KEY (id);


--
-- Name: user_bonus_consumptions user_bonus_consumptions_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.user_bonus_consumptions
    ADD CONSTRAINT user_bonus_consumptions_pkey PRIMARY KEY (id);


--
-- Name: user_bonus_consumptions user_bonus_consumptions_unique_stake_bonus; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.user_bonus_consumptions
    ADD CONSTRAINT user_bonus_consumptions_unique_stake_bonus UNIQUE (user_bonus_id, stake_transaction_id);


--
-- Name: user_bonuses user_bonuses_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.user_bonuses
    ADD CONSTRAINT user_bonuses_pkey PRIMARY KEY (id);


--
-- Name: user_bonuses user_bonuses_unique_idempotency; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.user_bonuses
    ADD CONSTRAINT user_bonuses_unique_idempotency UNIQUE (idempotency_key);


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
-- Name: users users_referral_code_key; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_referral_code_key UNIQUE (referral_code);


--
-- Name: users users_telegram_id_key; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_telegram_id_key UNIQUE (telegram_id);


--
-- Name: vip_tiers vip_tiers_code_key; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.vip_tiers
    ADD CONSTRAINT vip_tiers_code_key UNIQUE (code);


--
-- Name: vip_tiers vip_tiers_level_key; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.vip_tiers
    ADD CONSTRAINT vip_tiers_level_key UNIQUE (level);


--
-- Name: vip_tiers vip_tiers_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.vip_tiers
    ADD CONSTRAINT vip_tiers_pkey PRIMARY KEY (id);


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
-- Name: idx_bingo_commission_rules_active_dates; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_bingo_commission_rules_active_dates ON public.bingo_commission_rules USING btree (is_active, starts_at, ends_at);


--
-- Name: idx_bingo_commission_rules_lookup; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_bingo_commission_rules_lookup ON public.bingo_commission_rules USING btree (room_id, stake_id, is_active, priority);


--
-- Name: idx_bingo_games_room_status; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_bingo_games_room_status ON public.bingo_games USING btree (room_id, status);


--
-- Name: idx_bingo_games_selection; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_bingo_games_selection ON public.bingo_games USING btree (status, selection_ends_at) WHERE ((status)::text = 'selection'::text);


--
-- Name: idx_bingo_games_stake_status; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_bingo_games_stake_status ON public.bingo_games USING btree (stake_id, status);


--
-- Name: idx_bingo_games_status_created; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_bingo_games_status_created ON public.bingo_games USING btree (status, created_at);


--
-- Name: idx_bingo_participant_cards_game; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_bingo_participant_cards_game ON public.bingo_participant_cards USING btree (game_id);


--
-- Name: idx_bingo_participant_cards_participant; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_bingo_participant_cards_participant ON public.bingo_participant_cards USING btree (participant_id);


--
-- Name: idx_bingo_participants_game; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_bingo_participants_game ON public.bingo_participants USING btree (game_id);


--
-- Name: idx_bingo_participants_user; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_bingo_participants_user ON public.bingo_participants USING btree (user_id);


--
-- Name: idx_bingo_room_stakes_stake; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_bingo_room_stakes_stake ON public.bingo_room_stakes USING btree (stake_id, status);


--
-- Name: idx_bingo_rooms_active; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_bingo_rooms_active ON public.bingo_rooms USING btree (status, id);


--
-- Name: idx_bingo_rooms_status; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_bingo_rooms_status ON public.bingo_rooms USING btree (status);


--
-- Name: idx_bingo_stakes_active_order; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_bingo_stakes_active_order ON public.bingo_stakes USING btree (is_active, display_order);


--
-- Name: idx_bingo_winners_game; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_bingo_winners_game ON public.bingo_winners USING btree (game_id);


--
-- Name: idx_bingo_winners_participant; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_bingo_winners_participant ON public.bingo_winners USING btree (participant_id);


--
-- Name: idx_bingo_winners_transaction; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_bingo_winners_transaction ON public.bingo_winners USING btree (transaction_id);


--
-- Name: idx_bingo_winners_user; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_bingo_winners_user ON public.bingo_winners USING btree (user_id);


--
-- Name: idx_bonus_campaigns_active; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_bonus_campaigns_active ON public.bonus_campaigns USING btree (is_active);


--
-- Name: idx_bonus_campaigns_dates; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_bonus_campaigns_dates ON public.bonus_campaigns USING btree (starts_at, ends_at);


--
-- Name: idx_bonus_campaigns_game_system; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_bonus_campaigns_game_system ON public.bonus_campaigns USING btree (game_system_id);


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
-- Name: idx_financial_transactions_transfer_source; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_financial_transactions_transfer_source ON public.financial_transactions USING btree (type, user_id, created_at DESC) WHERE ((type)::text = 'transfer'::text);


--
-- Name: idx_financial_transactions_type; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_financial_transactions_type ON public.financial_transactions USING btree (type, created_at DESC);


--
-- Name: idx_financial_transactions_user; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_financial_transactions_user ON public.financial_transactions USING btree (user_id, created_at DESC);


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
-- Name: idx_stake_funding_policies_active; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_stake_funding_policies_active ON public.stake_funding_policies USING btree (game_system_id, is_active, priority DESC);


--
-- Name: idx_stake_funding_policies_dates; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_stake_funding_policies_dates ON public.stake_funding_policies USING btree (starts_at, ends_at);


--
-- Name: idx_stake_funding_policies_game_system; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_stake_funding_policies_game_system ON public.stake_funding_policies USING btree (game_system_id);


--
-- Name: idx_stake_funding_policy_wallets_policy; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_stake_funding_policy_wallets_policy ON public.stake_funding_policy_wallets USING btree (policy_id, funding_order);


--
-- Name: idx_stake_funding_policy_wallets_wallet_type; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_stake_funding_policy_wallets_wallet_type ON public.stake_funding_policy_wallets USING btree (wallet_type);


--
-- Name: idx_transfer_rules_dates; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_transfer_rules_dates ON public.transfer_rules USING btree (starts_at, ends_at);


--
-- Name: idx_transfer_rules_lookup; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_transfer_rules_lookup ON public.transfer_rules USING btree (wallet_type, period, is_active, priority);


--
-- Name: idx_transfers_limit_lookup; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_transfers_limit_lookup ON public.transfers USING btree (sender_user_id, wallet_type, status, created_at DESC);


--
-- Name: idx_transfers_receiver; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_transfers_receiver ON public.transfers USING btree (receiver_user_id, created_at DESC);


--
-- Name: idx_transfers_receiver_wallet; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_transfers_receiver_wallet ON public.transfers USING btree (receiver_user_id, wallet_type, created_at DESC);


--
-- Name: idx_transfers_rule; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_transfers_rule ON public.transfers USING btree (rule_id, created_at DESC);


--
-- Name: idx_transfers_sender; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_transfers_sender ON public.transfers USING btree (sender_user_id, created_at DESC);


--
-- Name: idx_transfers_sender_wallet; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_transfers_sender_wallet ON public.transfers USING btree (sender_user_id, wallet_type, created_at DESC);


--
-- Name: idx_transfers_status; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_transfers_status ON public.transfers USING btree (status, created_at DESC);


--
-- Name: idx_user_bonus_consumptions_bonus; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_user_bonus_consumptions_bonus ON public.user_bonus_consumptions USING btree (user_bonus_id);


--
-- Name: idx_user_bonus_consumptions_stake; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_user_bonus_consumptions_stake ON public.user_bonus_consumptions USING btree (stake_transaction_id);


--
-- Name: idx_user_bonuses_campaign; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_user_bonuses_campaign ON public.user_bonuses USING btree (campaign_id);


--
-- Name: idx_user_bonuses_expiry; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_user_bonuses_expiry ON public.user_bonuses USING btree (expires_at);


--
-- Name: idx_user_bonuses_user; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_user_bonuses_user ON public.user_bonuses USING btree (user_id);


--
-- Name: idx_user_bonuses_user_status; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_user_bonuses_user_status ON public.user_bonuses USING btree (user_id, status);


--
-- Name: idx_users_phone; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_users_phone ON public.users USING btree (phone);


--
-- Name: idx_users_referral_code; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_users_referral_code ON public.users USING btree (referral_code);


--
-- Name: idx_users_referred_by; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_users_referred_by ON public.users USING btree (referred_by_user_id);


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
-- Name: uq_bingo_games_active_room_stake; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE UNIQUE INDEX uq_bingo_games_active_room_stake ON public.bingo_games USING btree (room_id, stake_id) WHERE ((status)::text = ANY ((ARRAY['waiting'::character varying, 'selection'::character varying])::text[]));


--
-- Name: uq_bingo_games_idempotency_key; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE UNIQUE INDEX uq_bingo_games_idempotency_key ON public.bingo_games USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: uq_financial_transactions_idempotency; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE UNIQUE INDEX uq_financial_transactions_idempotency ON public.financial_transactions USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: uq_financial_transactions_reversal; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE UNIQUE INDEX uq_financial_transactions_reversal ON public.financial_transactions USING btree (reversed_transaction_id) WHERE (reversed_transaction_id IS NOT NULL);


--
-- Name: uq_transfer_rules_active_wallet_period; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE UNIQUE INDEX uq_transfer_rules_active_wallet_period ON public.transfer_rules USING btree (wallet_type, period) WHERE (is_active = true);


--
-- Name: uq_transfers_idempotency_key; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE UNIQUE INDEX uq_transfers_idempotency_key ON public.transfers USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: uq_transfers_transaction_id; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE UNIQUE INDEX uq_transfers_transaction_id ON public.transfers USING btree (transaction_id);


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
-- Name: ledger_entries ledger_entries_immutable; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER ledger_entries_immutable BEFORE DELETE OR UPDATE ON public.ledger_entries FOR EACH ROW EXECUTE FUNCTION public.prevent_ledger_entries_mutation();


--
-- Name: stake_funding_policies stake_funding_policies_set_updated_at; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER stake_funding_policies_set_updated_at BEFORE UPDATE ON public.stake_funding_policies FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: transfer_rules transfer_rules_set_updated_at; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER transfer_rules_set_updated_at BEFORE UPDATE ON public.transfer_rules FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


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
-- Name: bingo_commission_rules bingo_commission_rules_room_fk; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_commission_rules
    ADD CONSTRAINT bingo_commission_rules_room_fk FOREIGN KEY (room_id) REFERENCES public.bingo_rooms(id) ON DELETE RESTRICT;


--
-- Name: bingo_commission_rules bingo_commission_rules_stake_fk; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_commission_rules
    ADD CONSTRAINT bingo_commission_rules_stake_fk FOREIGN KEY (stake_id) REFERENCES public.bingo_stakes(id) ON DELETE RESTRICT;


--
-- Name: bingo_games bingo_games_commission_rule_fk; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_games
    ADD CONSTRAINT bingo_games_commission_rule_fk FOREIGN KEY (commission_rule_id) REFERENCES public.bingo_commission_rules(id) ON DELETE RESTRICT;


--
-- Name: bingo_games bingo_games_room_fk; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_games
    ADD CONSTRAINT bingo_games_room_fk FOREIGN KEY (room_id) REFERENCES public.bingo_rooms(id) ON DELETE RESTRICT;


--
-- Name: bingo_games bingo_games_stake_fk; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_games
    ADD CONSTRAINT bingo_games_stake_fk FOREIGN KEY (stake_id) REFERENCES public.bingo_stakes(id) ON DELETE RESTRICT;


--
-- Name: bingo_participant_cards bingo_participant_cards_game_fk; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_participant_cards
    ADD CONSTRAINT bingo_participant_cards_game_fk FOREIGN KEY (game_id) REFERENCES public.bingo_games(id) ON DELETE RESTRICT;


--
-- Name: bingo_participant_cards bingo_participant_cards_participant_fk; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_participant_cards
    ADD CONSTRAINT bingo_participant_cards_participant_fk FOREIGN KEY (participant_id) REFERENCES public.bingo_participants(id) ON DELETE RESTRICT;


--
-- Name: bingo_participant_cards bingo_participant_cards_transaction_fk; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_participant_cards
    ADD CONSTRAINT bingo_participant_cards_transaction_fk FOREIGN KEY (transaction_id) REFERENCES public.financial_transactions(id) ON DELETE RESTRICT;


--
-- Name: bingo_participants bingo_participants_game_fk; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_participants
    ADD CONSTRAINT bingo_participants_game_fk FOREIGN KEY (game_id) REFERENCES public.bingo_games(id) ON DELETE RESTRICT;


--
-- Name: bingo_participants bingo_participants_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_participants
    ADD CONSTRAINT bingo_participants_user_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: bingo_room_stakes bingo_room_stakes_room_fk; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_room_stakes
    ADD CONSTRAINT bingo_room_stakes_room_fk FOREIGN KEY (room_id) REFERENCES public.bingo_rooms(id) ON DELETE CASCADE;


--
-- Name: bingo_room_stakes bingo_room_stakes_stake_fk; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_room_stakes
    ADD CONSTRAINT bingo_room_stakes_stake_fk FOREIGN KEY (stake_id) REFERENCES public.bingo_stakes(id) ON DELETE RESTRICT;


--
-- Name: bingo_winners bingo_winners_game_fk; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_winners
    ADD CONSTRAINT bingo_winners_game_fk FOREIGN KEY (game_id) REFERENCES public.bingo_games(id) ON DELETE RESTRICT;


--
-- Name: bingo_winners bingo_winners_participant_fk; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_winners
    ADD CONSTRAINT bingo_winners_participant_fk FOREIGN KEY (participant_id) REFERENCES public.bingo_participants(id) ON DELETE RESTRICT;


--
-- Name: bingo_winners bingo_winners_transaction_fk; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_winners
    ADD CONSTRAINT bingo_winners_transaction_fk FOREIGN KEY (transaction_id) REFERENCES public.financial_transactions(id) ON DELETE RESTRICT;


--
-- Name: bingo_winners bingo_winners_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_winners
    ADD CONSTRAINT bingo_winners_user_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: bonus_campaigns bonus_campaigns_game_system_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bonus_campaigns
    ADD CONSTRAINT bonus_campaigns_game_system_id_fkey FOREIGN KEY (game_system_id) REFERENCES public.game_systems(id) ON DELETE SET NULL;


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
-- Name: bingo_rooms fk_bingo_rooms_commission_rule; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.bingo_rooms
    ADD CONSTRAINT fk_bingo_rooms_commission_rule FOREIGN KEY (commission_rule_id) REFERENCES public.bingo_commission_rules(id);


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
-- Name: stake_funding_policies stake_funding_policies_game_system_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.stake_funding_policies
    ADD CONSTRAINT stake_funding_policies_game_system_id_fkey FOREIGN KEY (game_system_id) REFERENCES public.game_systems(id) ON DELETE RESTRICT;


--
-- Name: stake_funding_policy_wallets stake_funding_policy_wallets_policy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.stake_funding_policy_wallets
    ADD CONSTRAINT stake_funding_policy_wallets_policy_id_fkey FOREIGN KEY (policy_id) REFERENCES public.stake_funding_policies(id) ON DELETE CASCADE;


--
-- Name: transfers transfers_receiver_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.transfers
    ADD CONSTRAINT transfers_receiver_user_id_fkey FOREIGN KEY (receiver_user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: transfers transfers_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.transfers
    ADD CONSTRAINT transfers_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.transfer_rules(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: transfers transfers_sender_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.transfers
    ADD CONSTRAINT transfers_sender_user_id_fkey FOREIGN KEY (sender_user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: transfers transfers_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.transfers
    ADD CONSTRAINT transfers_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.financial_transactions(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: user_bonus_consumptions user_bonus_consumptions_stake_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.user_bonus_consumptions
    ADD CONSTRAINT user_bonus_consumptions_stake_transaction_id_fkey FOREIGN KEY (stake_transaction_id) REFERENCES public.financial_transactions(id) ON DELETE RESTRICT;


--
-- Name: user_bonus_consumptions user_bonus_consumptions_user_bonus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.user_bonus_consumptions
    ADD CONSTRAINT user_bonus_consumptions_user_bonus_id_fkey FOREIGN KEY (user_bonus_id) REFERENCES public.user_bonuses(id) ON DELETE RESTRICT;


--
-- Name: user_bonuses user_bonuses_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.user_bonuses
    ADD CONSTRAINT user_bonuses_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.bonus_campaigns(id) ON DELETE RESTRICT;


--
-- Name: user_bonuses user_bonuses_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.user_bonuses
    ADD CONSTRAINT user_bonuses_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: users users_referred_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_referred_by_user_id_fkey FOREIGN KEY (referred_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: users users_vip_tier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_vip_tier_id_fkey FOREIGN KEY (vip_tier_id) REFERENCES public.vip_tiers(id);


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

