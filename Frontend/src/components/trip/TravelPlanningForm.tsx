"use client";

import { useEffect, useState, useCallback } from "react";
import LocationInput from "@/components/ui/LocationInput";
import type { Coordinates } from "@/lib/osrm";
import {
  currencySymbol,
  formatAmount,
  getExchangeRates,
  rateFor,
  tripCurrencyFor,
} from "@/lib/agent/currency";

export interface TravelFormData {
  origin: string;
  originCoords: Coordinates | null;
  destination: string;
  destinationCoords: Coordinates | null;
  startDate: string;
  endDate: string;
  numDays: number;
  numTravelers: number;
  numAdults: number;
  numChildren: number;
  /** Budget is stored in USD; `budgetCurrency` is only how it is displayed. */
  totalBudget: number;
  budgetCurrency?: string;
  transportation: string;
  accommodationType: string;
  accommodationBudget: number;
  foodPreference: string;
  interests: string[];
  travelPace: string;
  placesToVisit: string;
  additionalRequirements: string;
}

interface TravelPlanningFormProps {
  onSubmit: (data: TravelFormData) => void;
  onBuilder?: (data: TravelFormData) => void;
  loading?: boolean;
  initial?: Partial<TravelFormData>;
}

const TRANSPORT_OPTIONS = [
  "Any / No preference",
  "Flight",
  "Train",
  "Bus",
  "Car rental",
  "Public transit",
  "Walking / Cycling",
];

const ACCOMMODATION_OPTIONS = [
  "Any / No preference",
  "Hotel (3-star)",
  "Hotel (4-star)",
  "Hotel (5-star / Luxury)",
  "Hostel",
  "Guesthouse / B&B",
  "Vacation rental (Airbnb)",
  "Resort",
  "Camping / Hostel",
];

const FOOD_OPTIONS = [
  "Any / No preference",
  "Street food & local markets",
  "Fine dining",
  "Budget-friendly",
  "Vegetarian / Vegan",
  "Halal",
  "Kosher",
  "Local cuisine focused",
  "International chains",
];

const INTEREST_OPTIONS = [
  "Sightseeing & Landmarks",
  "Museums & Art",
  "Nature & Outdoors",
  "Beach & Water Sports",
  "Adventure & Sports",
  "Nightlife & Entertainment",
  "Shopping",
  "Food & Culinary Tours",
  "History & Culture",
  "Photography",
  "Wellness & Spa",
  "Family-friendly activities",
  "Romantic experiences",
  "Local experiences & Hidden gems",
  "Festivals & Events",
];

const PACE_OPTIONS = [
  { value: "relaxed", label: "Relaxed", desc: "Few activities per day, lots of downtime" },
  { value: "moderate", label: "Moderate", desc: "Balanced mix of activities and rest" },
  { value: "packed", label: "Packed", desc: "Maximize every moment, see it all" },
];

const FIELD =
  "w-full px-4 py-3 border border-zinc-700 bg-zinc-950/60 rounded-lg text-md text-ink placeholder-zinc-500 outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-blue-500/25";
const LABEL = "block text-sm font-medium text-zinc-300 mb-2";
const ERROR = "text-sm text-danger mt-1";

export default function TravelPlanningForm({
  onSubmit,
  onBuilder,
  loading,
  initial,
}: TravelPlanningFormProps) {
  const [step, setStep] = useState(1);
  const totalSteps = 4;

  const [form, setForm] = useState<TravelFormData>({
    origin: "",
    originCoords: null,
    destination: "",
    destinationCoords: null,
    startDate: "",
    endDate: "",
    numDays: 3,
    numTravelers: 1,
    numAdults: 1,
    numChildren: 0,
    totalBudget: 1000,
    transportation: "Any / No preference",
    accommodationType: "Any / No preference",
    accommodationBudget: 100,
    foodPreference: "Any / No preference",
    interests: [],
    travelPace: "moderate",
    placesToVisit: "",
    additionalRequirements: "",
    ...initial,
  });

  const [errors, setErrors] = useState<Record<string, string>>({});

  // Budget currency follows the trip's source and destination (origin first,
  // then destination) until the traveller picks one explicitly.
  const trip = tripCurrencyFor(form.origin, form.destination);
  const currency = form.budgetCurrency || trip.code;
  const currencyOptions = trip.options.includes(currency)
    ? trip.options
    : [currency, ...trip.options].slice(0, 3);

  // Live rates (free, cached) so the slider can show local amounts.
  const [, setRatesReady] = useState(0);
  useEffect(() => {
    let alive = true;
    getExchangeRates("USD").then(() => {
      if (alive) setRatesReady((n) => n + 1);
    });
    return () => {
      alive = false;
    };
  }, []);

  const rate = rateFor(currency);
  const money = (usd: number) => formatAmount(usd, currency);

  /** Slider bounds/step expressed in the display currency. */
  const sliderSpec = (minUsd: number, maxUsd: number, stepUsd: number) => {
    const min = Math.max(1, Math.round(minUsd * rate));
    const max = Math.max(min + 1, Math.round(maxUsd * rate));
    const raw = Math.max(stepUsd * rate, 1);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    const step = Math.max(1, Math.round((n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag));
    return { min, max, step };
  };
  const toUsd = (local: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, Math.round(local / rate)));

  const update = useCallback(<K extends keyof TravelFormData>(key: K, value: TravelFormData[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const toggleInterest = (interest: string) => {
    setForm((prev) => ({
      ...prev,
      interests: prev.interests.includes(interest)
        ? prev.interests.filter((i) => i !== interest)
        : [...prev.interests, interest],
    }));
  };

  const calculateDays = () => {
    if (form.startDate && form.endDate) {
      const start = new Date(form.startDate);
      const end = new Date(form.endDate);
      const diff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
      if (diff > 0) update("numDays", diff);
    }
  };

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!form.origin.trim()) e.origin = "Starting location is required";
    if (!form.destination.trim()) e.destination = "Destination is required";
    if (!form.startDate) e.startDate = "Start date is required";
    if (!form.endDate) e.endDate = "End date is required";
    if (form.startDate && form.endDate && new Date(form.endDate) <= new Date(form.startDate)) {
      e.endDate = "End date must be after start date";
    }
    if (form.numDays < 1) e.numDays = "Trip must be at least 1 day";
    if (form.numAdults < 1) e.numAdults = "At least 1 adult is required";
    if (form.totalBudget < 50) e.totalBudget = `Minimum budget is ${formatAmount(50, currency)}`;
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = () => {
    if (validate()) {
      onSubmit(form);
    }
  };

  const handleBuilder = () => {
    if (validate()) {
      onBuilder?.(form);
    }
  };

  const canNext = () => {
    if (step === 1) return form.origin.trim() && form.destination.trim();
    if (step === 2) return form.startDate && form.endDate && form.numDays >= 1;
    return true;
  };

  return (
    <div className="max-w-3xl mx-auto">
      {/* Header */}
      <div className="text-center mb-12">
        <p className="eyebrow mb-3">
          Step {step} of {totalSteps}
        </p>
        <h1 className="text-3xl md:text-4xl font-semibold tracking-tight text-ink mb-2">
          Tell us about the trip
        </h1>
        <p className="text-ink-muted text-md">
          Four short steps. We&apos;ll use your answers to start the plan in chat.
        </p>
      </div>

      {/* Step Indicator */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-3">
          {Array.from({ length: totalSteps }).map((_, i) => (
            <div key={i} className="flex items-center">
              <div
                className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold transition-colors ${
                  i + 1 < step
                    ? "bg-accent-strong text-white"
                    : i + 1 === step
                      ? "bg-accent-strong/15 text-blue-300 ring-1 ring-blue-500/50"
                      : "bg-surface-2 text-ink-faint"
                }`}
              >
                {i + 1 < step ? (
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                ) : (
                  i + 1
                )}
              </div>
              {i < totalSteps - 1 && (
                <div
                  className={`hidden md:block w-12 lg:w-24 h-px mx-2 transition-colors ${i + 1 < step ? "bg-accent-strong" : "bg-white/10"}`}
                />
              )}
            </div>
          ))}
        </div>
        <div className="flex justify-between text-xs font-medium">
          <span className={step >= 1 ? "text-blue-400" : "text-ink-faint"}>Locations</span>
          <span className={step >= 2 ? "text-blue-400" : "text-ink-faint"}>Dates &amp; group</span>
          <span className={step >= 3 ? "text-blue-400" : "text-ink-faint"}>Preferences</span>
          <span className={step >= 4 ? "text-blue-400" : "text-ink-faint"}>Review</span>
        </div>
      </div>

      {/* Form Card */}
      <div className="bg-zinc-900/70 rounded-xl shadow-xl border border-hairline p-6 md:p-12 animate-fade-in">
        {step === 1 && (
          <div className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold text-ink mb-1">Where are you traveling?</h2>
              <p className="text-ink-muted text-sm">Enter your starting point and destination.</p>
            </div>

            <LocationInput
              dark
              label="Starting location"
              value={form.origin}
              onChange={(v, coords) => {
                update("origin", v);
                if (coords) update("originCoords", coords);
              }}
              placeholder="e.g. New York, USA"
            />
            {errors.origin && (
              <p className="text-sm text-danger flex items-center gap-1">
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    fillRule="evenodd"
                    d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                    clipRule="evenodd"
                  />
                </svg>
                {errors.origin}
              </p>
            )}

            <LocationInput
              dark
              label="Destination"
              value={form.destination}
              onChange={(v, coords) => {
                update("destination", v);
                if (coords) update("destinationCoords", coords);
              }}
              placeholder="e.g. Paris, France"
            />
            {errors.destination && (
              <p className="text-sm text-danger flex items-center gap-1">
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    fillRule="evenodd"
                    d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                    clipRule="evenodd"
                  />
                </svg>
                {errors.destination}
              </p>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="space-y-6 animate-fade-in">
            <div>
              <h2 className="text-lg font-semibold text-ink mb-1">When and who?</h2>
              <p className="text-ink-muted text-sm">Set your travel dates and group size.</p>
            </div>

            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <label className={LABEL}>Start date</label>
                <input
                  type="date"
                  value={form.startDate}
                  onChange={(e) => {
                    update("startDate", e.target.value);
                    setTimeout(calculateDays, 0);
                  }}
                  min={new Date().toISOString().split("T")[0]}
                  className={FIELD}
                />
                {errors.startDate && <p className={ERROR}>{errors.startDate}</p>}
              </div>
              <div>
                <label className={LABEL}>End date</label>
                <input
                  type="date"
                  value={form.endDate}
                  onChange={(e) => {
                    update("endDate", e.target.value);
                    setTimeout(calculateDays, 0);
                  }}
                  min={form.startDate || new Date().toISOString().split("T")[0]}
                  className={FIELD}
                />
                {errors.endDate && <p className={ERROR}>{errors.endDate}</p>}
              </div>
            </div>

            <div>
              <label className={LABEL}>Number of days</label>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => update("numDays", Math.max(1, form.numDays - 1))}
                  className="w-11 h-11 rounded-lg border border-zinc-700 flex items-center justify-center text-zinc-300 hover:bg-surface-2 hover:border-zinc-600 transition-colors font-medium text-lg"
                >
                  −
                </button>
                <input
                  type="number"
                  value={form.numDays}
                  onChange={(e) => update("numDays", Math.max(1, parseInt(e.target.value) || 1))}
                  min={1}
                  max={60}
                  className="flex-1 px-4 py-3 border border-zinc-700 bg-zinc-950/60 rounded-lg focus:border-accent focus:ring-2 focus:ring-blue-500/25 outline-none transition-colors text-center font-semibold text-lg text-ink"
                />
                <button
                  type="button"
                  onClick={() => update("numDays", Math.min(60, form.numDays + 1))}
                  className="w-11 h-11 rounded-lg border border-zinc-700 flex items-center justify-center text-zinc-300 hover:bg-surface-2 hover:border-zinc-600 transition-colors font-medium text-lg"
                >
                  +
                </button>
              </div>
            </div>

            <div className="grid md:grid-cols-3 gap-4">
              <div>
                <label className={LABEL}>Adults</label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const v = Math.max(1, form.numAdults - 1);
                      update("numAdults", v);
                      update("numTravelers", v + form.numChildren);
                    }}
                    className="w-11 h-11 shrink-0 rounded-lg border border-zinc-700 flex items-center justify-center hover:bg-surface-2 active:bg-surface-3 transition-colors font-medium text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
                  >
                    −
                  </button>
                  <input
                    type="number"
                    value={form.numAdults}
                    onChange={(e) => {
                      const v = Math.max(1, parseInt(e.target.value) || 1);
                      update("numAdults", v);
                      update("numTravelers", v + form.numChildren);
                    }}
                    min={1}
                    max={20}
                    className="w-full px-2 py-3 border border-zinc-700 bg-zinc-950/60 rounded-lg focus:border-accent focus:ring-2 focus:ring-blue-500/25 outline-none text-center font-semibold text-ink"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const v = form.numAdults + 1;
                      update("numAdults", v);
                      update("numTravelers", v + form.numChildren);
                    }}
                    className="w-11 h-11 shrink-0 rounded-lg border border-zinc-700 flex items-center justify-center hover:bg-surface-2 active:bg-surface-3 transition-colors font-medium text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
                  >
                    +
                  </button>
                </div>
                {errors.numAdults && <p className={ERROR}>{errors.numAdults}</p>}
              </div>
              <div>
                <label className={LABEL}>Children</label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const v = Math.max(0, form.numChildren - 1);
                      update("numChildren", v);
                      update("numTravelers", form.numAdults + v);
                    }}
                    className="w-11 h-11 shrink-0 rounded-lg border border-zinc-700 flex items-center justify-center hover:bg-surface-2 active:bg-surface-3 transition-colors font-medium text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
                  >
                    −
                  </button>
                  <input
                    type="number"
                    value={form.numChildren}
                    onChange={(e) => {
                      const v = Math.max(0, parseInt(e.target.value) || 0);
                      update("numChildren", v);
                      update("numTravelers", form.numAdults + v);
                    }}
                    min={0}
                    max={20}
                    className="w-full px-2 py-3 border border-zinc-700 bg-zinc-950/60 rounded-lg focus:border-accent focus:ring-2 focus:ring-blue-500/25 outline-none text-center font-semibold text-ink"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const v = form.numChildren + 1;
                      update("numChildren", v);
                      update("numTravelers", form.numAdults + v);
                    }}
                    className="w-11 h-11 shrink-0 rounded-lg border border-zinc-700 flex items-center justify-center hover:bg-surface-2 active:bg-surface-3 transition-colors font-medium text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
                  >
                    +
                  </button>
                </div>
              </div>
              <div>
                <label className={LABEL}>Total travelers</label>
                <div className="w-full px-4 py-3 border border-zinc-700 bg-zinc-950/60 rounded-lg text-ink font-semibold text-lg text-center">
                  {form.numTravelers}
                </div>
              </div>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-6 animate-fade-in">
            <div>
              <h2 className="text-lg font-semibold text-ink mb-1">Your preferences</h2>
              <p className="text-ink-muted text-sm">These shape budget, stays and pacing.</p>
            </div>

            <div>
              <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                <label className="block text-sm font-medium text-zinc-300">
                  Total budget <span className="text-ink-faint font-normal">({currency})</span>
                </label>
                {currencyOptions.length > 1 && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-ink-faint">Currency</span>
                    {currencyOptions.map((c) => (
                      <button
                        key={c}
                        type="button"
                        title={c}
                        aria-pressed={c === currency}
                        onClick={() => update("budgetCurrency", c)}
                        className={`min-h-touch px-3 py-2 rounded-md text-xs font-semibold border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 ${
                          c === currency
                            ? "bg-accent-strong border-accent text-white"
                            : "border-zinc-700 text-ink-muted hover:border-zinc-500 hover:text-zinc-200"
                        }`}
                      >
                        {currencySymbol(c)} {c}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="bg-zinc-950/60 border border-hairline rounded-xl p-6">
                <input
                  type="range"
                  min={sliderSpec(50, 20000, 50).min}
                  max={sliderSpec(50, 20000, 50).max}
                  step={sliderSpec(50, 20000, 50).step}
                  value={Math.round(form.totalBudget * rate)}
                  onChange={(e) =>
                    update("totalBudget", toUsd(parseInt(e.target.value), 50, 20000))
                  }
                  className="w-full h-1.5 bg-zinc-700 rounded-full appearance-none cursor-pointer accent-blue-600"
                />
                <div className="flex justify-between items-baseline text-sm text-ink-faint mt-3">
                  <span>{money(50)}</span>
                  <span className="font-semibold text-ink text-2xl tabular-nums">
                    {money(form.totalBudget)}
                  </span>
                  <span>{money(20000)}</span>
                </div>
                {currency !== "USD" && (
                  <p className="text-xs text-ink-faint text-center mt-2">
                    ≈ {formatAmount(form.totalBudget, "USD")} in USD
                  </p>
                )}
              </div>
              {errors.totalBudget && <p className="text-sm text-danger">{errors.totalBudget}</p>}
            </div>

            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <label className={LABEL}>Preferred transportation</label>
                <select
                  value={form.transportation}
                  onChange={(e) => update("transportation", e.target.value)}
                  className={FIELD}
                >
                  {TRANSPORT_OPTIONS.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={LABEL}>Accommodation type</label>
                <select
                  value={form.accommodationType}
                  onChange={(e) => update("accommodationType", e.target.value)}
                  className={FIELD}
                >
                  {ACCOMMODATION_OPTIONS.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-3">
                Nightly accommodation budget{" "}
                <span className="text-ink-faint font-normal">({currency})</span>
              </label>
              <div className="bg-zinc-950/60 border border-hairline rounded-xl p-6">
                <input
                  type="range"
                  min={sliderSpec(10, 1000, 10).min}
                  max={sliderSpec(10, 1000, 10).max}
                  step={sliderSpec(10, 1000, 10).step}
                  value={Math.round(form.accommodationBudget * rate)}
                  onChange={(e) =>
                    update("accommodationBudget", toUsd(parseInt(e.target.value), 10, 1000))
                  }
                  className="w-full h-1.5 bg-zinc-700 rounded-full appearance-none cursor-pointer accent-blue-600"
                />
                <div className="flex justify-between items-baseline text-sm text-ink-faint mt-3">
                  <span>{money(10)}</span>
                  <span className="font-semibold text-ink text-2xl tabular-nums">
                    {money(form.accommodationBudget)}/night
                  </span>
                  <span>{money(1000)}</span>
                </div>
                {currency !== "USD" && (
                  <p className="text-xs text-ink-faint text-center mt-2">
                    ≈ {formatAmount(form.accommodationBudget, "USD")} in USD
                  </p>
                )}
              </div>
            </div>

            <div>
              <label className={LABEL}>Food preference</label>
              <select
                value={form.foodPreference}
                onChange={(e) => update("foodPreference", e.target.value)}
                className={FIELD}
              >
                {FOOD_OPTIONS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-3">
                Travel interests (select all that apply)
              </label>
              <div className="flex flex-wrap gap-2">
                {INTEREST_OPTIONS.map((interest) => (
                  <button
                    key={interest}
                    type="button"
                    onClick={() => toggleInterest(interest)}
                    className={`min-h-touch px-4 py-3 rounded-md text-base font-medium transition-colors border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 ${
                      form.interests.includes(interest)
                        ? "bg-accent-strong text-white border-accent-strong"
                        : "bg-transparent text-zinc-300 border-zinc-700 hover:border-zinc-500 hover:text-ink"
                    }`}
                  >
                    {interest}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-3">
                Travel pace
              </label>
              <div className="grid md:grid-cols-3 gap-3">
                {PACE_OPTIONS.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => update("travelPace", p.value)}
                    className={`p-4 rounded-lg border text-left transition-colors ${
                      form.travelPace === p.value
                        ? "border-accent bg-accent/10"
                        : "border-zinc-700 hover:border-zinc-600"
                    }`}
                  >
                    <div
                      className={`font-semibold text-sm ${form.travelPace === p.value ? "text-blue-300" : "text-ink"}`}
                    >
                      {p.label}
                    </div>
                    <div className="text-xs text-ink-muted mt-2 leading-relaxed">{p.desc}</div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-6 animate-fade-in">
            <div>
              <h2 className="text-lg font-semibold text-ink mb-1">Final details</h2>
              <p className="text-ink-muted text-sm">Any specific places or extra requirements?</p>
            </div>

            <div>
              <label className={LABEL}>Places / activities you want to visit</label>
              <textarea
                value={form.placesToVisit}
                onChange={(e) => update("placesToVisit", e.target.value)}
                rows={3}
                placeholder="e.g. Eiffel Tower, Louvre Museum, Seine River Cruise, Montmartre..."
                className={`${FIELD} resize-none`}
              />
            </div>

            <div>
              <label className={LABEL}>Additional requirements</label>
              <textarea
                value={form.additionalRequirements}
                onChange={(e) => update("additionalRequirements", e.target.value)}
                rows={3}
                placeholder="e.g. Wheelchair accessible, travel with pets, vegetarian only, avoid flying..."
                className={`${FIELD} resize-none`}
              />
            </div>

            {/* Trip Summary */}
            <div className="bg-zinc-950/60 rounded-xl p-6 space-y-3 border border-hairline">
              <h3 className="font-semibold text-ink">Trip summary</h3>
              <div className="grid md:grid-cols-2 gap-2 text-sm">
                {[
                  { label: "From", value: form.origin || "Not set" },
                  { label: "To", value: form.destination || "Not set" },
                  {
                    label: "Dates",
                    value:
                      form.startDate && form.endDate
                        ? `${form.startDate} to ${form.endDate}`
                        : "Not set",
                  },
                  { label: "Duration", value: `${form.numDays} days` },
                  {
                    label: "Travelers",
                    value: `${form.numAdults} adults${form.numChildren > 0 ? `, ${form.numChildren} children` : ""}`,
                  },
                  {
                    label: "Budget",
                    value: `${money(form.totalBudget)}${currency !== "USD" ? ` (${currency})` : ""}`,
                  },
                  { label: "Transport", value: form.transportation },
                  { label: "Stay", value: form.accommodationType },
                  {
                    label: "Pace",
                    value: form.travelPace.charAt(0).toUpperCase() + form.travelPace.slice(1),
                  },
                  {
                    label: "Interests",
                    value: form.interests.length
                      ? `${form.interests.length} selected`
                      : "None selected",
                  },
                ].map((item) => (
                  <div
                    key={item.label}
                    className="flex justify-between gap-3 bg-surface-1 rounded-lg px-3 py-2"
                  >
                    <span className="text-ink-muted">{item.label}</span>
                    <span className="font-medium text-ink text-right truncate">
                      {item.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Navigation */}
        <div className="flex justify-between mt-8 pt-6 border-t border-hairline">
          {step > 1 ? (
            <button
              onClick={() => setStep(step - 1)}
              className="min-h-touch px-4 py-3 text-zinc-300 text-sm font-medium rounded-lg hover:bg-surface-2 active:bg-surface-3 transition-colors flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
              Back
            </button>
          ) : (
            <div />
          )}

          {step < totalSteps ? (
            <button
              onClick={() => canNext() && setStep(step + 1)}
              disabled={!canNext()}
              className="min-h-touch px-6 py-3 bg-accent-strong text-white text-sm font-medium rounded-lg hover:bg-accent active:bg-blue-700 disabled:bg-surface-2 disabled:text-zinc-600 disabled:cursor-not-allowed transition-colors flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70"
            >
              Continue
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5l7 7-7 7"
                />
              </svg>
            </button>
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {onBuilder && (
                <button
                  onClick={handleBuilder}
                  disabled={loading}
                  className="min-h-touch px-4 py-3 text-zinc-300 text-sm font-medium rounded-lg border border-zinc-700 hover:bg-surface-2 hover:text-ink active:bg-surface-3 disabled:bg-surface-2 disabled:text-zinc-600 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
                >
                  Plan step-by-step
                </button>
              )}
              <button
                onClick={handleSubmit}
                disabled={loading}
                className="min-h-touch px-6 py-3 bg-accent-strong text-white text-sm font-medium rounded-lg hover:bg-accent active:bg-blue-700 disabled:bg-surface-2 disabled:text-zinc-600 disabled:cursor-not-allowed transition-colors flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70"
              >
                {loading ? (
                  <>
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                        fill="none"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                      />
                    </svg>
                    Working...
                  </>
                ) : (
                  <>
                    Start planning in chat
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M13 7l5 5m0 0l-5 5m5-5H6"
                      />
                    </svg>
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
