"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import TravelPlanningForm, { type TravelFormData } from "@/components/trip/TravelPlanningForm";
import ItineraryDisplay from "@/components/trip/ItineraryDisplay";
import ProgressivePlanner from "@/components/trip/ProgressivePlanner";
import HomeBackground from "@/components/home/HomeBackground";
import { formatAmount, tripCurrencyFor } from "@/lib/agent/currency";

export default function PlanPage() {
  const router = useRouter();

  // Travel Planner state
  const [generating, setGenerating] = useState(false);
  const [tripPlan, setTripPlan] = useState<Record<string, unknown> | null>(null);
  const [builderForm, setBuilderForm] = useState<TravelFormData | null>(null);
  const [lastForm, setLastForm] = useState<TravelFormData | null>(null);
  const [formError, setFormError] = useState("");

  // Travel Planner handlers — the form seeds the conversational planner in /chat
  const handleFormSubmit = (formData: TravelFormData) => {
    setFormError("");
    setTripPlan(null);
    setLastForm(formData);

    const parts: string[] = [];
    const where = formData.destination || formData.origin;
    if (where) parts.push(`I want to visit ${where}`);
    if (formData.origin && formData.destination) parts.push(`flying from ${formData.origin}`);
    if (formData.startDate) parts.push(`departing ${formData.startDate}`);
    if (formData.endDate) parts.push(`returning ${formData.endDate}`);
    if (formData.numDays) parts.push(`${formData.numDays} days`);
    if (formData.numTravelers) parts.push(`for ${formData.numTravelers} travelers`);
    if (formData.totalBudget) {
      const budgetCurrency =
        formData.budgetCurrency || tripCurrencyFor(formData.origin, formData.destination).code;
      parts.push(`budget around ${formatAmount(formData.totalBudget, budgetCurrency)}`);
    }
    if (formData.interests?.length) parts.push(`into ${formData.interests.join(", ")}`);
    if (formData.foodPreference && !/no preference/i.test(formData.foodPreference)) {
      parts.push(`food preference: ${formData.foodPreference}`);
    }
    if (formData.accommodationType && !/no preference/i.test(formData.accommodationType)) {
      parts.push(`stay: ${formData.accommodationType}`);
    }
    if (formData.placesToVisit) parts.push(`want to see ${formData.placesToVisit}`);
    if (formData.additionalRequirements) parts.push(formData.additionalRequirements);

    const seed = parts.join(", ").replace(/\s+/g, " ").trim();
    router.push(`/chat?q=${encodeURIComponent(seed)}`);
  };

  const handleBuildTrip = async (s: {
    stays: string[];
    places: string[];
    transportation?: string;
  }): Promise<boolean> => {
    if (!builderForm) return false;
    setGenerating(true);
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...builderForm,
          ...(s.transportation ? { transportation: s.transportation } : {}),
          suggestedStays: s.stays,
          suggestedPlaces: s.places,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.details || data.error || "Failed to generate travel plan");
      }
      setTripPlan(data.plan);
      setBuilderForm(null);
      return true;
    } catch {
      return false;
    } finally {
      setGenerating(false);
    }
  };

  const handleRestartBuilder = () => {
    setBuilderForm(null);
    setFormError("");
  };

  const handleBuilderSubmit = (formData: TravelFormData) => {
    setFormError("");
    setTripPlan(null);
    setBuilderForm(formData);
    setLastForm(formData);
  };

  const handleModifyWithChat = () => {
    router.push("/chat");
  };

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 lg:px-8 py-8">
      <HomeBackground />
      {!tripPlan && !builderForm && !generating && (
        <TravelPlanningForm
          onSubmit={handleFormSubmit}
          onBuilder={handleBuilderSubmit}
          loading={generating}
          initial={lastForm ?? undefined}
        />
      )}

      {builderForm && !tripPlan && (
        <ProgressivePlanner
          form={builderForm}
          onBuild={handleBuildTrip}
          onRestart={handleRestartBuilder}
        />
      )}

      {formError && !generating && (
        <div className="max-w-3xl mx-auto mt-6">
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-6 text-center">
            <h3 className="text-lg font-semibold text-red-300 mb-2">
              Couldn&apos;t generate the trip
            </h3>
            <p className="text-red-300/80 text-sm mb-4">{formError}</p>
            <button
              onClick={() => {
                setFormError("");
                setTripPlan(null);
              }}
              className="inline-flex min-h-touch items-center rounded-lg bg-red-500 px-6 py-2 text-sm font-medium text-white transition-colors hover:bg-red-600 active:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/70"
            >
              Try again
            </button>
          </div>
        </div>
      )}

      {tripPlan && !generating && (
        <div className="mt-4">
          <ItineraryDisplay
            plan={tripPlan as Parameters<typeof ItineraryDisplay>[0]["plan"]}
            onModify={handleModifyWithChat}
          />
        </div>
      )}
    </div>
  );
}
