# gIVEMEGAME.IO — Stripe Billing MVP

## Summary

Webhook-first Stripe billing for one paid plan: **Pro Teacher Monthly**. Paid access is provisioned only via verified webhook events, never from success-page redirects.

## Files Changed

| File | Change |
|------|--------|
| `server.js` | Billing API routes, webhook handler, rate limit gating, `optionalSupabaseUser` |
| `lib/billing.js` | `getUserBillingState`, `hasPaidAccess`, webhook helpers |
| `supabase/migrations/016_billing.sql` | `user_billing`, `billing_events` tables |
| `supabase/RUN_ALL_MIGRATIONS.sql` | 016 billing appended |
| `public/index.html` | Billing section in profile modal |
| `public/script.js` | `App.Billing` module, success/cancel handling |
| `public/js/game-api.js` | Auth header for generate-game (Pro rate limit) |
| `public/style.css` | Billing section styles |
| `.env.example` | Stripe env vars (placeholders) |
| `test/billing.test.js` | Unit tests for `hasPaidAccess` |
| `test/integration/billing.test.js` | Integration tests for billing API |

## New Env Vars

```env
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PRO_MONTHLY=price_...
STRIPE_CHECKOUT_SUCCESS_URL=   # optional, defaults to host/index.html?billing=success
STRIPE_CHECKOUT_CANCEL_URL=    # optional
STRIPE_PORTAL_RETURN_URL=      # optional
```

## DB Schema (016)

- **user_billing**: `user_id`, `stripe_customer_id`, `stripe_subscription_id`, `stripe_price_id`, `subscription_status`, `current_period_end`, `plan_code`, `billing_state_updated_at`
- **billing_events**: `stripe_event_id` (UNIQUE), `event_type` — idempotency

## Handled Stripe Events

- `checkout.session.completed` — provision paid access
- `customer.subscription.created` / `updated` — update billing state
- `customer.subscription.deleted` — revoke access
- `invoice.payment_failed` — sync status (e.g. past_due)

## Gating Logic

- **hasPaidAccess**: `active` and `trialing` → true; `canceled`, `unpaid`, `incomplete_expired`, `past_due` → false
- **Feature gating**: `/api/generate-game` rate limit — 10/min (free), 30/min (Pro)
- Authenticated requests include `Authorization: Bearer <token>`; server resolves user and billing state for limit

## Migration Steps

1. Run `supabase/RUN_ALL_MIGRATIONS.sql` or apply `016_billing.sql` in Supabase Dashboard
2. Create Stripe product + recurring price, copy Price ID to `STRIPE_PRICE_PRO_MONTHLY`
3. Configure webhook in Stripe Dashboard → `POST /api/stripe/webhook` → copy signing secret to `STRIPE_WEBHOOK_SECRET`
4. Set `STRIPE_SECRET_KEY` (test or live)

## Local Test Steps

```bash
npm install
cp .env.example .env
# Edit .env with Stripe keys and Supabase URL

# Run migration (or apply 016 manually)
npm run db:migrate

# Start server
npm start

# Tests
node --test test/billing.test.js test/integration/billing.test.js
```

## Production Deployment Checklist

- [ ] Run 016 migration on production Supabase
- [ ] Create Stripe live product + price
- [ ] Add live keys to Vercel env
- [ ] Configure Stripe webhook with production URL
- [ ] Ensure webhook route receives raw body (Express `express.raw` before `express.json`)
- [ ] Verify `success_url` and `cancel_url` use production domain

## Phase 2 TODOs

- Annual plans
- Team / seat-based billing
- Coupon / promo codes
- Tax engine
- Analytics dashboard
- Past-due grace period (optional paid access until period end)
