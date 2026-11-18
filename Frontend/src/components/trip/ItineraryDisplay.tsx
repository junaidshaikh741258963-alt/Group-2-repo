"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import type { Coordinates } from "@/lib/osrm";

const TravelMap = dynamic(() => import("@/components/map/TravelMap"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-100 bg-surface-3 rounded-xl animate-pulse flex items-center justify-center text-ink-faint">
      Loading map...
    </div>
  ),
});

interface Activity {
  time: string;
  name: string;
  type: string;
  description: string;
  duration: string;
  estimatedCost: string;
  tips?: string;
}

interface ItineraryDay {
  day: number;
  date: string;
  title: string;
  weather: string;
  activities: Activity[];
  meals: { breakfast: string; lunch: string; dinner: string };
  dailyBudget: string;
}

interface TripPlan {
  tripOverview?: {
    title: string;
    summary: string;
    destination: string;
    duration: string;
    bestTimeToVisit?: string;
    totalEstimatedCost: string;
    currency?: string;
  };
  budgetBreakdown?: {
    transportation: string;
    accommodation: string;
    food: string;
    activities: string;
    miscellaneous: string;
    total: string;
  };
  itinerary?: ItineraryDay[];
  transportationGuide?: {
    gettingThere: string;
    localTransport: string;
    tips: string[];
  };
  accommodationRecommendations?: Array<{
    name: string;
    type: string;
    priceRange: string;
    location: string;
    whyRecommended: string;
  }>;
  foodGuide?: {
    mustTryDishes: string[];
    recommendedRestaurants: Array<{
      name: string;
      cuisine: string;
      priceRange: string;
      area: string;
    }>;
    tips: string[];
  };
  practicalInfo?: {
    weatherSummary: string;
    packingList: string[];
    safetyTips: string[];
    culturalNotes: string[];
    emergencyContacts: string[];
    visaInfo: string;
  };
  mapData?: {
    centerLat: number;
    centerLng: number;
    zoom: number;
    markers: Array<{
      lat: number;
      lng: number;
      label: string;
      type: string;
    }>;
  };
  alternativeOptions?: {
    budgetFriendly: string;
    luxuryUpgrade: string;
    rainyDayAlternatives: string[];
  };
  rawResponse?: string;
}

interface ItineraryDisplayProps {
  plan: TripPlan;
  onModify?: () => void;
}

const ACTIVITY_ICONS: Record<string, string> = {
  attraction: "🎯",
  restaurant: "🍽️",
  transport: "🚌",
  hotel: "🏨",
  activity: "⚡",
  shopping: "🛍️",
  museum: "🏛️",
  nature: "🌿",
  default: "📍",
};

function ActivityIcon({ type }: { type: string }) {
  const icon = ACTIVITY_ICONS[String(type ?? "").toLowerCase()] || ACTIVITY_ICONS.default;
  return (
    <div className="w-11 h-11 rounded-xl bg-accent/12 flex items-center justify-center text-lg shrink-0 border border-accent/25">
      {icon}
    </div>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-surface-1 rounded-2xl border border-hairline overflow-hidden">
      <div className="px-6 py-6 border-b border-hairline flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-accent/12 flex items-center justify-center text-xl">
          {icon}
        </div>
        <h3 className="font-bold text-ink text-lg">{title}</h3>
      </div>
      <div className="p-6 md:p-8">{children}</div>
    </div>
  );
}

export default function ItineraryDisplay({ plan, onModify }: ItineraryDisplayProps) {
  const [activeDay, setActiveDay] = useState(0);

  const overview = plan.tripOverview;
  const budget = plan.budgetBreakdown;
  const itinerary = plan.itinerary || [];
  const currentDay = itinerary[activeDay];

  const mapCenter: Coordinates = plan.mapData
    ? { lat: plan.mapData.centerLat, lng: plan.mapData.centerLng }
    : { lat: 0, lng: 0 };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {plan.rawResponse ? (
        <div className="bg-surface-1 rounded-2xl border border-hairline p-8">
          <h2 className="text-2xl font-bold text-ink mb-4">Your Travel Plan</h2>
          <div className="prose prose-gray max-w-none whitespace-pre-wrap text-zinc-200 leading-relaxed">
            {plan.rawResponse}
          </div>
          {onModify && (
            <div className="mt-6 flex gap-3">
              <button
                onClick={onModify}
                className="px-6 py-3 border border-white/[0.12] text-zinc-200 font-medium rounded-xl hover:bg-surface-2 transition-all"
              >
                Modify with Chat
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Trip Overview */}
          {overview && (
            <div className="relative bg-accent/10 border border-accent/25 rounded-2xl p-8 md:p-12 overflow-hidden">
              <div className="relative">
                <div className="inline-flex items-center gap-2 px-3 py-1 bg-surface-2 text-zinc-300 text-xs font-medium rounded-full mb-4">
                  <span className="w-1.5 h-1.5 bg-ok rounded-full" />
                  AI-generated plan
                </div>
                <h1 className="text-3xl md:text-4xl font-semibold tracking-tight text-ink mb-3">
                  {overview.title}
                </h1>
                <p className="text-zinc-300 text-lg mb-8 max-w-3xl leading-relaxed">
                  {overview.summary}
                </p>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="bg-surface-2 rounded-2xl px-4 py-4 border border-hairline">
                    <div className="text-xs text-ink-muted mb-1">Destination</div>
                    <div className="font-semibold text-ink">{overview.destination}</div>
                  </div>
                  <div className="bg-surface-2 rounded-2xl px-4 py-4 border border-hairline">
                    <div className="text-xs text-ink-muted mb-1">Duration</div>
                    <div className="font-semibold text-ink">{overview.duration}</div>
                  </div>
                  <div className="bg-surface-2 rounded-2xl px-4 py-4 border border-hairline">
                    <div className="text-xs text-ink-muted mb-1">Est. total cost</div>
                    <div className="font-semibold text-ink">{overview.totalEstimatedCost}</div>
                  </div>
                  {overview.bestTimeToVisit && (
                    <div className="bg-surface-2 rounded-2xl px-4 py-4 border border-hairline">
                      <div className="text-xs text-ink-muted mb-1">Best time</div>
                      <div className="font-semibold text-ink">{overview.bestTimeToVisit}</div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Budget Breakdown */}
          {budget && (
            <Section title="Budget Breakdown" icon="💰">
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                {[
                  {
                    label: "Transportation",
                    value: budget.transportation,
                    color: "blue",
                    icon: "🚌",
                  },
                  {
                    label: "Accommodation",
                    value: budget.accommodation,
                    color: "purple",
                    icon: "🏨",
                  },
                  { label: "Food & Dining", value: budget.food, color: "green", icon: "🍽️" },
                  { label: "Activities", value: budget.activities, color: "amber", icon: "🎯" },
                  {
                    label: "Miscellaneous",
                    value: budget.miscellaneous,
                    color: "gray",
                    icon: "📦",
                  },
                ].map((item) => (
                  <div
                    key={item.label}
                    className="bg-surface-1 rounded-2xl p-6 border border-hairline"
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-lg">{item.icon}</span>
                      <span className="text-sm text-ink-muted font-medium">{item.label}</span>
                    </div>
                    <div className="text-xl font-bold text-ink">{item.value}</div>
                  </div>
                ))}
                <div className="bg-surface-3 border border-white/[0.12] rounded-2xl p-6">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-lg">💎</span>
                    <span className="text-sm text-ink-muted font-medium">Total estimated</span>
                  </div>
                  <div className="text-xl font-semibold text-ink">{budget.total}</div>
                </div>
              </div>
            </Section>
          )}

          {/* Day-by-Day Itinerary */}
          {itinerary.length > 0 && (
            <Section title="Day-by-Day Itinerary" icon="📅">
              <div className="flex gap-2 overflow-x-auto pb-3 mb-6 -mx-2 px-2">
                {itinerary.map((day, i) => (
                  <button
                    key={day.day}
                    onClick={() => setActiveDay(i)}
                    className={`shrink-0 min-h-touch px-6 py-3 rounded-xl text-sm font-bold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 ${
                      i === activeDay
                        ? "bg-accent-strong text-white"
                        : "bg-surface-3 text-zinc-300 hover:bg-white/[0.14]"
                    }`}
                  >
                    Day {day.day}
                  </button>
                ))}
              </div>

              {currentDay && (
                <div className="space-y-5">
                  <div className="flex items-center justify-between flex-wrap gap-3">
                    <div>
                      <h4 className="font-bold text-ink text-xl">{currentDay.title}</h4>
                      <p className="text-sm text-ink-muted mt-1">{currentDay.date}</p>
                    </div>
                    <div className="flex gap-3">
                      {currentDay.weather && (
                        <span className="px-4 py-2 bg-accent/12 text-blue-300 text-sm font-semibold rounded-full border border-accent/30">
                          {currentDay.weather}
                        </span>
                      )}
                      <span className="px-4 py-2 bg-green-500/12 text-green-300 text-sm font-semibold rounded-full border border-green-500/30">
                        {currentDay.dailyBudget}
                      </span>
                    </div>
                  </div>

                  <div className="space-y-3">
                    {(currentDay.activities ?? []).map((activity, j) => (
                      <div
                        key={j}
                        className="flex gap-4 p-6 bg-surface-1 rounded-2xl border border-hairline"
                      >
                        <ActivityIcon type={activity.type} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-mono text-blue-400 bg-accent/12 px-3 py-1 rounded-lg font-semibold">
                              {activity.time}
                            </span>
                            <span className="font-bold text-ink">{activity.name}</span>
                          </div>
                          <p className="text-sm text-zinc-300 mt-2 leading-relaxed">
                            {activity.description}
                          </p>
                          <div className="flex items-center gap-4 mt-3 text-xs text-ink-muted">
                            <span className="flex items-center gap-1">⏱ {activity.duration}</span>
                            <span className="flex items-center gap-1">
                              💰 {activity.estimatedCost}
                            </span>
                            {activity.tips && (
                              <span className="text-warn flex items-center gap-1">
                                💡 {activity.tips}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {currentDay.meals && (
                    <div className="bg-amber-500/10 rounded-2xl p-6 border border-amber-500/25">
                      <h5 className="font-bold text-ink mb-3 flex items-center gap-2">
                        <span className="text-xl">🍽️</span> Meal Recommendations
                      </h5>
                      <div className="grid md:grid-cols-3 gap-4 text-sm">
                        <div className="bg-surface-2 rounded-xl p-3">
                          <div className="text-warn font-medium text-xs mb-1">Breakfast</div>
                          <div className="text-zinc-200">{currentDay.meals.breakfast}</div>
                        </div>
                        <div className="bg-surface-2 rounded-xl p-3">
                          <div className="text-warn font-medium text-xs mb-1">Lunch</div>
                          <div className="text-zinc-200">{currentDay.meals.lunch}</div>
                        </div>
                        <div className="bg-surface-2 rounded-xl p-3">
                          <div className="text-warn font-medium text-xs mb-1">Dinner</div>
                          <div className="text-zinc-200">{currentDay.meals.dinner}</div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </Section>
          )}

          {/* Transportation Guide */}
          {plan.transportationGuide && (
            <Section title="Transportation Guide" icon="🚌">
              <div className="space-y-4">
                <div>
                  <h5 className="font-semibold text-ink mb-1">Getting There</h5>
                  <p className="text-zinc-300 text-sm">{plan.transportationGuide.gettingThere}</p>
                </div>
                <div>
                  <h5 className="font-semibold text-ink mb-1">Getting Around Locally</h5>
                  <p className="text-zinc-300 text-sm">{plan.transportationGuide.localTransport}</p>
                </div>
                {plan.transportationGuide.tips?.length > 0 && (
                  <div>
                    <h5 className="font-semibold text-ink mb-2">Tips</h5>
                    <ul className="space-y-1">
                      {plan.transportationGuide.tips.map((tip, i) => (
                        <li key={i} className="text-sm text-zinc-300 flex items-start gap-2">
                          <span className="text-accent mt-1">•</span> {tip}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </Section>
          )}

          {/* Where to Stay */}
          {plan.accommodationRecommendations && plan.accommodationRecommendations.length > 0 && (
            <Section title="Where to Stay" icon="🏨">
              <div className="grid md:grid-cols-2 gap-4">
                {plan.accommodationRecommendations.map((hotel, i) => (
                  <div
                    key={i}
                    className="border-2 border-hairline rounded-2xl p-6 hover:border-accent/50 transition-all"
                  >
                    <h5 className="font-bold text-ink">{hotel.name}</h5>
                    <p className="text-sm text-ink-muted mt-1">
                      {hotel.type} · {hotel.location}
                    </p>
                    <p className="text-blue-400 font-bold text-sm mt-2">{hotel.priceRange}</p>
                    <p className="text-sm text-zinc-300 mt-2 leading-relaxed">
                      {hotel.whyRecommended}
                    </p>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Food Guide */}
          {plan.foodGuide && (
            <Section title="Food Guide" icon="🍽️">
              <div className="space-y-6">
                {plan.foodGuide.mustTryDishes?.length > 0 && (
                  <div>
                    <h5 className="font-semibold text-ink mb-2">Must-Try Dishes</h5>
                    <div className="flex flex-wrap gap-2">
                      {plan.foodGuide.mustTryDishes.map((dish, i) => (
                        <span
                          key={i}
                          className="px-3 py-1 bg-orange-500/12 text-orange-300 text-sm rounded-full"
                        >
                          {dish}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {plan.foodGuide.recommendedRestaurants?.length > 0 && (
                  <div>
                    <h5 className="font-semibold text-ink mb-2">Recommended Restaurants</h5>
                    <div className="grid md:grid-cols-2 gap-3">
                      {plan.foodGuide.recommendedRestaurants.map((r, i) => (
                        <div key={i} className="bg-surface-2 rounded-lg p-3">
                          <div className="font-medium text-ink text-sm">{r.name}</div>
                          <div className="text-xs text-ink-muted">
                            {r.cuisine} · {r.area} · {r.priceRange}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {plan.foodGuide.tips?.length > 0 && (
                  <div>
                    <h5 className="font-semibold text-ink mb-2">Food Tips</h5>
                    <ul className="space-y-1">
                      {plan.foodGuide.tips.map((tip, i) => (
                        <li key={i} className="text-sm text-zinc-300 flex items-start gap-2">
                          <span className="text-orange-400 mt-1">•</span> {tip}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </Section>
          )}

          {/* Practical Info */}
          {plan.practicalInfo && (
            <Section title="Practical Information" icon="ℹ️">
              <div className="space-y-5">
                {plan.practicalInfo.weatherSummary && (
                  <div className="bg-accent/12 rounded-xl p-4">
                    <h5 className="font-semibold text-blue-200 mb-1">Weather</h5>
                    <p className="text-sm text-blue-300">{plan.practicalInfo.weatherSummary}</p>
                  </div>
                )}

                {plan.practicalInfo.packingList?.length > 0 && (
                  <div>
                    <h5 className="font-semibold text-ink mb-2">Packing Checklist</h5>
                    <div className="grid md:grid-cols-2 gap-1">
                      {plan.practicalInfo.packingList.map((item, i) => (
                        <label
                          key={i}
                          className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer py-1"
                        >
                          <input type="checkbox" className="rounded border-hairline-strong" />
                          {item}
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {plan.practicalInfo.safetyTips?.length > 0 && (
                  <div>
                    <h5 className="font-semibold text-ink mb-2">Safety Tips</h5>
                    <ul className="space-y-1">
                      {plan.practicalInfo.safetyTips.map((tip, i) => (
                        <li key={i} className="text-sm text-zinc-300 flex items-start gap-2">
                          <span className="text-red-500 mt-1">•</span> {tip}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {plan.practicalInfo.culturalNotes?.length > 0 && (
                  <div>
                    <h5 className="font-semibold text-ink mb-2">Cultural Notes</h5>
                    <ul className="space-y-1">
                      {plan.practicalInfo.culturalNotes.map((note, i) => (
                        <li key={i} className="text-sm text-zinc-300 flex items-start gap-2">
                          <span className="text-purple-400 mt-1">•</span> {note}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {plan.practicalInfo.visaInfo && (
                  <div className="bg-surface-2 rounded-xl p-4">
                    <h5 className="font-semibold text-ink mb-1">Visa Information</h5>
                    <p className="text-sm text-zinc-300">{plan.practicalInfo.visaInfo}</p>
                  </div>
                )}

                {plan.practicalInfo.emergencyContacts?.length > 0 && (
                  <div>
                    <h5 className="font-semibold text-ink mb-2">Emergency Contacts</h5>
                    <ul className="space-y-1">
                      {plan.practicalInfo.emergencyContacts.map((contact, i) => (
                        <li key={i} className="text-sm text-zinc-300">
                          {contact}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </Section>
          )}

          {/* Alternative Options */}
          {plan.alternativeOptions && (
            <Section title="Alternative Options" icon="🔄">
              <div className="space-y-4">
                {plan.alternativeOptions.budgetFriendly && (
                  <div className="bg-green-500/12 rounded-xl p-4">
                    <h5 className="font-semibold text-green-200 mb-1">💰 Budget-Friendly Tips</h5>
                    <p className="text-sm text-green-300">
                      {plan.alternativeOptions.budgetFriendly}
                    </p>
                  </div>
                )}
                {plan.alternativeOptions.luxuryUpgrade && (
                  <div className="bg-purple-500/12 rounded-xl p-4">
                    <h5 className="font-semibold text-purple-200 mb-1">✨ Luxury Upgrade</h5>
                    <p className="text-sm text-purple-300">
                      {plan.alternativeOptions.luxuryUpgrade}
                    </p>
                  </div>
                )}
                {plan.alternativeOptions.rainyDayAlternatives?.length > 0 && (
                  <div>
                    <h5 className="font-semibold text-ink mb-2">🌧️ Rainy Day Alternatives</h5>
                    <ul className="space-y-1">
                      {plan.alternativeOptions.rainyDayAlternatives.map((alt, i) => (
                        <li key={i} className="text-sm text-zinc-300 flex items-start gap-2">
                          <span className="text-accent mt-1">•</span> {alt}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </Section>
          )}

          {/* Map */}
          {plan.mapData && plan.mapData.markers && plan.mapData.markers.length > 0 && (
            <Section title="Interactive Map" icon="🗺️">
              <div style={{ height: "400px" }}>
                <TravelMap
                  origin={
                    plan.mapData.markers[0]
                      ? { lat: plan.mapData.markers[0].lat, lng: plan.mapData.markers[0].lng }
                      : null
                  }
                  destination={mapCenter}
                  route={null}
                />
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {plan.mapData.markers.map((m, i) => (
                  <span
                    key={i}
                    className="px-3 py-1 bg-surface-3 text-zinc-300 text-xs rounded-full"
                  >
                    {ACTIVITY_ICONS[m.type] || "📍"} {m.label}
                  </span>
                ))}
              </div>
            </Section>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-4 justify-center py-6">
            {onModify && (
              <button
                onClick={onModify}
                className="px-8 py-4 border-2 border-white/[0.12] text-zinc-200 font-bold rounded-xl hover:bg-surface-2 hover:border-hairline-strong transition-all flex items-center gap-2"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                  />
                </svg>
                Modify with AI Chat
              </button>
            )}
            <button
              onClick={() => window.print()}
              className="px-8 py-4 border-2 border-white/[0.12] text-zinc-200 font-bold rounded-xl hover:bg-surface-2 hover:border-hairline-strong transition-all flex items-center gap-2"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"
                />
              </svg>
              Print / Export PDF
            </button>
          </div>
        </>
      )}
    </div>
  );
}
