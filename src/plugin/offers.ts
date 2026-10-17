export interface OfferWindow {
  readonly durationMinutes: number;
  readonly maxUses: number;
}

export interface Offer {
  readonly id: string;
  readonly business: string;
  readonly name: string;
  readonly description: string;
  readonly priceUsd: number;
  readonly window: OfferWindow;
  /** The protected base URL this pass unlocks. */
  readonly url: string;
}

// Phase 1 ships these hardcoded. An *offer* (what's for sale) stays separate from a
// *pass* (what someone bought), so this file is untouched when the pass store lands.
// acme-weather-* targets the merchant app built in Phase 4; northwind proves multi-tenancy.
// The merchant runs in this same process, so an offer's URL is the live tunnel the agent will
// actually call. Falls back to a stable placeholder when PUBLIC_URL isn't set (local tests).
const BASE = (process.env.PUBLIC_URL ?? "https://api.acme-weather.example").replace(/\/$/, "");

export const OFFERS: readonly Offer[] = [
  {
    id: "acme-weather-day",
    business: "Acme Weather API",
    name: "Day pass",
    description:
      "Unmetered current-conditions and forecast reads across every location in the Acme catalog.",
    priceUsd: 0.5,
    window: { durationMinutes: 1440, maxUses: 500 },
    url: `${BASE}/v1/weather`,
  },
  {
    id: "acme-weather-week",
    business: "Acme Weather API",
    name: "Week pass",
    description: "Seven days of the same access, for agents that run on a schedule.",
    priceUsd: 2,
    window: { durationMinutes: 10080, maxUses: 3000 },
    url: `${BASE}/v1/weather`,
  },
  {
    id: "northwind-quote-hour",
    business: "Northwind Market Data",
    name: "Hour pass",
    description: "Sixty minutes of live FX and commodity quotes, refreshed on demand.",
    priceUsd: 0.25,
    window: { durationMinutes: 60, maxUses: 60 },
    url: `${BASE}/v1/quotes`,
  },
];

export function findOffer(offerId: string): Offer | undefined {
  return OFFERS.find((o) => o.id === offerId);
}

/**
 * The protected path is derived from `url` rather than repeated, so the merchant can never
 * drift from the catalogue — and the price is always converted through `usdToAtomic`, the same
 * function the plugin's published `maxAmount` comes from. PayBox checks the settled amount
 * against the proposal, so those two must agree exactly.
 */
export function offerPath(offer: Offer): string {
  return new URL(offer.url).pathname;
}
