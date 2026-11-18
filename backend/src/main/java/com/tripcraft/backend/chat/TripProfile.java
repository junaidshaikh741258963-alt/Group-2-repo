package com.tripcraft.backend.chat;

/**
 * The trip's planning profile — the TS {@code TripProfile} interface.
 *
 * <p>Deliberately a mutable class with public fields rather than a record: the
 * TS helpers do {@code const next = { ...profile }} and then mutate the copy
 * ({@code next.destination = …}). {@link #copy()} reproduces that shallow copy
 * exactly, and the {@code null} means "not established yet" the same way the TS
 * {@code string | null} does.
 */
public class TripProfile {

    public String destination;
    public String dates;
    public String people;
    public String budget;
    public String interests;
    public String duration;
    public String accommodation;
    public String hotel;
    public String restaurants;
    public String attractions;
    public String itinerary;

    public TripProfile() {
    }

    public TripProfile(String destination, String dates, String people, String budget,
            String interests, String duration, String accommodation, String hotel,
            String restaurants, String attractions, String itinerary) {
        this.destination = destination;
        this.dates = dates;
        this.people = people;
        this.budget = budget;
        this.interests = interests;
        this.duration = duration;
        this.accommodation = accommodation;
        this.hotel = hotel;
        this.restaurants = restaurants;
        this.attractions = attractions;
        this.itinerary = itinerary;
    }

    /** TS {@code { ...profile }}. */
    public TripProfile copy() {
        return new TripProfile(destination, dates, people, budget, interests, duration,
                accommodation, hotel, restaurants, attractions, itinerary);
    }

    /** TS {@code profile[field]} for the fields the stage machine iterates. */
    public String get(PlanningField field) {
        switch (field) {
            case DESTINATION:
                return destination;
            case DATES:
                return dates;
            case PEOPLE:
                return people;
            case BUDGET:
                return budget;
            case INTERESTS:
                return interests;
            case DURATION:
                return duration;
            case ACCOMMODATION:
                return accommodation;
            case HOTEL:
                return hotel;
            case RESTAURANTS:
                return restaurants;
            case ATTRACTIONS:
                return attractions;
            case ITINERARY:
                return itinerary;
            default:
                return null;
        }
    }

    /** TS {@code profile[field] = value}. */
    public void set(PlanningField field, String value) {
        switch (field) {
            case DESTINATION -> destination = value;
            case DATES -> dates = value;
            case PEOPLE -> people = value;
            case BUDGET -> budget = value;
            case INTERESTS -> interests = value;
            case DURATION -> duration = value;
            case ACCOMMODATION -> accommodation = value;
            case HOTEL -> hotel = value;
            case RESTAURANTS -> restaurants = value;
            case ATTRACTIONS -> attractions = value;
            case ITINERARY -> itinerary = value;
            default -> {
                // "done" is a machine state, not a profile slot — nothing to set.
            }
        }
    }
}
