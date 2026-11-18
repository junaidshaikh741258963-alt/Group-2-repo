/**
 * Stable travel knowledge base — the "vector DB / RAG knowledge source".
 *
 * Only evergreen content belongs here (customs, history, how things work).
 * Anything volatile — prices, availability, opening hours, flight fares —
 * must come from the live retriever instead, never from this file.
 *
 * Each doc: title + a compact factual paragraph + tags for retrieval recall.
 */

export interface KnowledgeDoc {
  id: string;
  title: string;
  category: string;
  /** Factual paragraph (the payload sent to the LLM). */
  text: string;
  /** Extra keywords / synonyms for recall. */
  tags: string;
  /** Ingested docs only: city the chunk belongs to. */
  city?: string;
  /** Ingested docs only: canonical source URL (Wikivoyage article). */
  url?: string;
  /** Ingested docs only: ISO date the chunk was fetched. */
  fetchedAt?: string;
  /** Ingested docs only: corpus provenance ("wikivoyage"). */
  source?: string;
}

export const KNOWLEDGE_CORPUS: KnowledgeDoc[] = [
  {
    id: "kyo-imperial-palace",
    title: "Tokyo Imperial Palace — history and visiting",
    category: "destinations",
    text: "The Imperial Palace in Tokyo stands on the site of the former Edo Castle, the seat of the Tokugawa shoguns from 1603. After the Meiji Restoration the emperor moved from Kyoto to Edo in 1869 and the castle became the imperial residence. The original palace burned in 1945 during the war and the present main palace was completed in 1968. Visitors can walk the Kokyo Gaien plaza, cross the Nijubashi bridges over the moat, and tour the free East Gardens, which retain original stone walls and guard towers. Interior tours of the palace itself require advance application through the Imperial Household Agency.",
    tags: "edo castle shogun tokugawa meiji emperor east gardens nijubashi moat tokyo history japan",
  },
  {
    id: "kyo-tokyo-overview",
    title: "Tokyo — neighbourhoods and orientation",
    category: "destinations",
    text: "Tokyo is made of distinct centres rather than one core. Shibuya and Harajuku are for youth culture and shopping, Shinjuku for nightlife, transport and the government district, Asakusa for old temples such as Senso-ji, and Akihabara for electronics and anime. The Yamanote loop line connects most major stations. Distances are long: central cross-town trips take 30 to 45 minutes by metro. Most visitors buy a rechargeable Suica or Pasmo card for trains, buses and convenience stores.",
    tags: "shibuya shinjuku harajuku asakusa akihabara senso-ji yamanote suica pasma metro japan",
  },
  {
    id: "japan-etiquette",
    title: "Japan — manners and etiquette",
    category: "culture",
    text: "Remove shoes when entering homes, ryokans, many restaurants and any space with tatami mats; look for a genkan entryway. Bow lightly as a greeting and thanks. Eat quietly — slurping noodles is acceptable, but talking on phones on trains is not. Carry trash with you; public bins are scarce. Tipping is not practised and can even cause confusion; excellent service is the standard. When visiting shrines and temples, wash hands at the temizuya, do not photograph restricted areas, and keep voices low.",
    tags: "shoes bow tipping shrine temple tatami manners custom polite rules tokyo kyoto japan",
  },
  {
    id: "japan-rail-pass",
    title: "Japan Rail Pass — how it works",
    category: "transport",
    text: "The Japan Rail Pass is a tourist-only pass covering most JR trains nationwide for a fixed number of consecutive days, including many shinkansen bullet-train rides (excluding the fastest Nozomi and Mizuho services). It must be bought before arrival and exchanged or activated at a JR ticket office. It pays off mainly for multi-city trips that include long shinkansen legs; for a Tokyo-and-Kyoto-only itinerary individual tickets can be cheaper. Seat reservations on JR trains are free with the pass.",
    tags: "jr pass shinkansen bullet train exchange activate nozomi seat reservation tokyo kyoto osaka japan",
  },
  {
    id: "japan-seasons",
    title: "When to visit Japan",
    category: "planning",
    text: "Cherry blossom season is roughly late March to mid-April and is the most crowded, expensive period. Autumn colour follows in mid-November to early December. June to mid-July is rainy season (tsuyu) in central Japan; Okinawa is subtropical and warm year-round. Summers are hot and humid with occasional typhoons from August to October, while winter brings heavy snow to the Sea of Japan coast and clear, cold days in Tokyo and Kyoto.",
    tags: "cherry blossom sakura rainy season tsuyu typhoon autumn leaves best time weather climate japan",
  },
  {
    id: "kyoto-temples",
    title: "Kyoto — temples and customs",
    category: "destinations",
    text: "Kyoto was Japan's capital for over a millennium and holds roughly 1,600 Buddhist temples and 400 Shinto shrines. Highlights include Kinkaku-ji (Golden Pavilion), Fushimi Inari's thousands of vermilion torii gates, Kiyomizu-dera on its wooden stage, and the bamboo grove of Arashiyama. Many temples charge small entry fees and close in the evening. The traditional district of Gion has geiko and maiko (Kyoto geisha) — do not block their path to photograph them.",
    tags: "kinkaku-ji fushimi inari kiyomizu arashiyama gion geiko maiko bamboo grove kyoto temples japan",
  },
  {
    id: "india-visa",
    title: "India — visas and entry",
    category: "planning",
    text: "Most foreign nationals need a visa for India; many nationalities are eligible for the e-Visa, applied for online before travel with a passport valid for at least six months and a return ticket. On arrival, immigration officials may ask for proof of accommodation and sufficient funds. Rules and eligible nationalities change, so always confirm on the official Indian government e-Visa site rather than third-party pages.",
    tags: "e-visa entry passport immigration valid six months apply online india visa",
  },
  {
    id: "india-trains",
    title: "India — booking trains (IRCTC)",
    category: "transport",
    text: "Indian Railways is booked through the IRCTC platform; tickets open weeks in advance and popular routes sell out, especially AC classes. Classes range from unreserved general coaches to AC 2-tier and AC 3-tier sleepers. Confirm your reservation status (PNR) before travel because waitlisted tickets can fail to be allotted. Station layouts are large — arrive early, check the platform (PF) on the noticeboard, and keep doors closed during the ride. Tatkal is the emergency same-day quota.",
    tags: "irctc pnr waitlist tatkal ac 3 tier sleeper reservation class indian railways delhi mumbai train india",
  },
  {
    id: "india-street-food",
    title: "India — food and water safety",
    category: "food",
    text: "Indian cuisine is extremely varied by region — Mughlai in the north, rice and seafood in the south, coconut-based dishes on the coast. For travellers: drink bottled or purified water, avoid ice of unknown origin, and prefer freshly cooked hot street stalls with high turnover. Vegetarian food is abundant everywhere and is often the default. Chillies are common — ask for 'not spicy' or 'kam mirch'. Eating with the right hand is customary in many traditional settings.",
    tags: "street food vegetarian spicy water bottle hygiene mughlai south indian curry delhi mumbai goa food india",
  },
  {
    id: "india-tipping",
    title: "Tipping norms — India and wider Asia",
    category: "culture",
    text: "In India, tipping around 10 percent in restaurants is appreciated where no service charge applies; porters and guides receive small notes. In Japan and South Korea tipping is not expected and may be refused. In Southeast Asia, rounding up the bill or leaving small change is common; hotel staff and tour guides are tipped modestly. When in doubt, follow what locals do — customs vary more between countries than guidebooks suggest.",
    tags: "tip gratuity service charge rounding up custom restaurant asia india japan korea thailand etiquette",
  },
  {
    id: "schengen-visa",
    title: "Schengen Area — visas and movement",
    category: "planning",
    text: "The Schengen Area lets one short-stay visa cover travel across most of continental Europe for up to 90 days in any 180-day period. Apply at the embassy of your main destination or first entry. Inside the area there are normally no passport checks at land borders, but airlines still check documents for flights. Non-Schengen countries such as the UK, Ireland and Croatia (euro but outside Schengen) have separate entry rules — check before combining them on one trip.",
    tags: "schengen europe visa 90 days 180 days passport border france italy germany spain entry rules",
  },
  {
    id: "europe-intercity",
    title: "Europe — intercity travel options",
    category: "transport",
    text: "For medium distances high-speed rail beats flying once city-centre transfer and airport time are counted: Paris–Lyon, Madrid–Barcelona, Milan–Rome and Berlin–Munich are all comfortable rail journeys. Long-distance coaches such as FlixBus are slower but cheaper. Eurail/Interrail passes suit multi-country rail trips; point-to-point tickets bought in advance are often cheaper on fixed routes. Overnight trains with couchettes survive on a handful of corridors and book out early.",
    tags: "eurail interrail tgv flixbus high speed rail coach night train europe paris lyon madrid barcelona",
  },
  {
    id: "europe-etiquette",
    title: "Europe — dining and dress customs",
    category: "culture",
    text: "In much of continental Europe, service is included in the bill or rounded up — leaving large tips marks you as a tourist. Cafés charge less at the counter than at a table. Cover shoulders and knees for churches and cathedrals; some basilicas deny entry to shorts and bare shoulders. In Italy, cappuccino is a morning drink and adding cheese to seafood pasta is frowned upon; in France, greet shopkeepers with 'bonjour' before asking anything.",
    tags: "service included tip church dress code cappuccino bonjour cafe etiquette italy france europe customs",
  },
  {
    id: "flight-booking",
    title: "Finding cheaper flights",
    category: "flights",
    text: "Domestic fares are often cheapest roughly one to three months ahead; international sweet spots vary but far-out and last-minute both tend to cost more. Mid-week departures are usually cheaper than weekend ones. Flexible dates and nearby airports can matter more than carrier choice. Set fare alerts, compare on more than one search site, then check the airline's own site — it may match the price with better change rules. Budget carriers advertise a low base fare and charge for bags and seats.",
    tags: "cheap fares booking window alert midweek nearby airport budget airline baggage seat price flights",
  },
  {
    id: "layovers-transfers",
    title: "Layovers and connection rules",
    category: "flights",
    text: "A self-transfer with separate tickets means you must collect bags, clear immigration if the arrival is international, and re-check in — at least two to three hours between flights, more at unfamiliar airports. With one through-ticket the airline handles transfers and your bags go to the final destination, but you still need enough minimum connection time (often 45–90 minutes depending on the airport). Overnight layovers may require a visa even if you never leave the airport in some countries.",
    tags: "layover connection transfer self transfer through ticket minimum connection time baggage visa airport",
  },
  {
    id: "travel-insurance",
    title: "Travel insurance — what it should cover",
    category: "planning",
    text: "A decent policy covers emergency medical treatment and hospitalisation, repatriation, trip cancellation or curtailment, lost or delayed baggage, and personal liability. Check that activities you plan — diving, trekking altitude, skiing, motorbiking — are included, since standard policies exclude them. Keep the insurer's emergency number offline. EHIC/GHIC cards give state healthcare in Europe but are not a substitute for full insurance, and they do not cover private care or repatriation.",
    tags: "insurance medical repatriation cancellation baggage policy cover claim trekking diving ehic ghic safety",
  },
  {
    id: "budgeting-trip",
    title: "Budgeting a trip",
    category: "planning",
    text: "Split a trip budget into transport, accommodation, food, activities and a buffer of about 10–15 percent for surprises. Accommodation and intercity transport are the two biggest levers — booking them early usually saves more than cutting daily meals. Track spending per day rather than per trip so overruns are visible early. Tell your bank you are travelling to avoid card blocks, and carry a small amount of local cash for markets and tips.",
    tags: "budget cost per day buffer transport accommodation cash card bank spending money saving planning",
  },
  {
    id: "packing-essentials",
    title: "Packing that actually matters",
    category: "planning",
    text: "Pack one versatile layer plus a rain shell rather than many heavy items, a universal power adapter, a portable charger, copies of documents stored separately from originals, and any prescription medicines in carry-on with a doctor's note where required. A refillable water bottle saves money and plastic. Roll or use packing cubes to double usable space. Check airline bag dimensions and weight limits before you leave — low-cost carriers enforce them strictly at the gate.",
    tags: "packing cubes adapter charger medicine documents carry on luggage weight limit roll bottle rain shell",
  },
  {
    id: "jet-lag",
    title: "Beating jet lag",
    category: "health",
    text: "Shift sleep toward the destination's time zone a few days before flying if the change is large. On arrival, get outdoor daylight in the morning — light is the strongest signal for resetting your body clock — and stay awake until a normal local bedtime. Hydrate in flight, limit alcohol, and move regularly to reduce swelling and clot risk. Short naps of under 30 minutes help; long daytime sleep delays adjustment. For eastward trips the shift is generally harder than westward.",
    tags: "jet lag sleep circadian daylight time zone eastward westward hydration flight health tired",
  },
  {
    id: "safety-basics",
    title: "Staying safe as a traveller",
    category: "safety",
    text: "Use hotel safes for passports and spare cards, keep one card separate from your wallet, and be wary of unsolicited 'helpers' at stations and tourist sites. Save your embassy's local number and a copy of your passport offline. Use official taxis or licensed ride-hailing apps at night. Check your government's travel advice for destination-specific alerts. Trust your instincts about areas after dark — this applies as much in familiar cities as unfamiliar ones.",
    tags: "safety scam pickpocket embassy alert advice taxi ride hailing night passport copy risk street smart",
  },
  {
    id: "solo-travel",
    title: "Solo travel",
    category: "planning",
    text: "Solo trips work best with simple logistics: central accommodation, daylight arrivals, and a rough plan for the first evening. Social options include walking tours, cooking classes, hostel common rooms and day trips. Tell someone your plan for remote days, keep regular check-ins, and book the first night before arriving. Dining alone is normal in most cities — counter seats and bar tables make it easier. Solo supplements on tours and cruises are common and worth budgeting for.",
    tags: "solo alone single traveller first night check in hostel walking tour dining alone supplement safety",
  },
  {
    id: "family-travel",
    title: "Travelling with children",
    category: "family",
    text: "Build in one slower day for every two busy ones, keep transit blocks under a couple of hours where possible, and time long journeys with sleep schedules. Family rooms beat triple rooms for space; many hotels list child policies and cots free on request. Choose attractions with hands-on elements over long museums, and locate the nearest pharmacy and clinic on arrival. Bring a familiar comfort item for young children — it travels better than extra toys.",
    tags: "family kids children child stroller cot family room slower pace playground pharmacy trip",
  },
  {
    id: "money-exchange",
    title: "Money abroad — cards vs cash",
    category: "money",
    text: "Cards are widely accepted in cities across Europe, Japan, Australia and North America; carry cash for markets, small vendors and tips in places where card coverage thins out. Airport exchange counters and street kiosks usually give the worst rates — a home-bank card with no foreign transaction fee plus ATMs abroad is typically cheapest. Tell your bank your dates. When offered a conversion to your home currency at an ATM or terminal, decline it ('charge in local currency') to avoid the dynamic exchange mark-up.",
    tags: "cash card atm exchange rate dynamic conversion foreign transaction fee airport kiosk currency money",
  },
  {
    id: "sim-esim",
    title: "Staying connected — SIM and eSIM",
    category: "planning",
    text: "An eSIM bought before arrival gives data the moment you land and avoids airport SIM queues; check your phone is unlocked and eSIM-compatible first. Physical tourist SIMs at the airport often bundle data and local calls but can be pricier. Free wifi covers much of Asia's cafés, malls and stations, though it is unreliable for navigation on the move. Download offline maps and translate packs before leaving wifi. VPNs help on open networks and for services restricted in some countries.",
    tags: "esim sim card wifi vpn offline maps data roaming airport phone unlocked connected connectivity",
  },
  {
    id: "food-water-abroad",
    title: "Food and water safety abroad",
    category: "health",
    text: "In countries where tap water is not safe, use bottled, boiled or filtered water — including for ice and brushing teeth — and avoid raw salads that may have been washed in it. Busy stalls with high turnover and food cooked at high heat are generally safer than long-displayed cold items. Hand sanitiser before eating matters more than any restaurant price bracket. Keep oral rehydration salts handy for stomach upsets, and see a doctor early if fever develops after travel.",
    tags: "tap water bottled ice salad hygiene stomach diarrhoea rehydration salts illness food safety health",
  },
  {
    id: "vegetarian-travel",
    title: "Travelling as a vegetarian or vegan",
    category: "food",
    text: "Vegetarian options are easy in India, the Middle East, Thailand and much of Europe; they take more planning in Japan, Scandinavia and parts of Latin America where broths and fish sauce are hidden staples. Learn the local phrase for 'no meat, no fish, no chicken' written on your phone. Hotel breakfasts and ethnic restaurants are reliable anchors. Vegan travellers should watch for dairy in breads, ghee in rice dishes and fish sauce in dressings.",
    tags: "vegetarian vegan no meat no fish ghee fish sauce broths diet food india thailand japan europe",
  },
  {
    id: "best-time-climate",
    title: "Choosing when to go — climate logic",
    category: "planning",
    text: "Work backwards from climate rather than calendar hype: Mediterranean summers are hot and dry, monsoon belts get heavy rain from roughly June to September in South Asia and later in Southeast Asia, and tropical cyclone seasons cluster in specific months. Shoulder seasons — spring and autumn in temperate zones — usually mean milder temperatures, thinner crowds and lower prices. Always check the destination's own season, not your home country's.",
    tags: "best time season monsoon cyclone shoulder season climate weather when to go crowd prices planning",
  },
  {
    id: "thailand-basics",
    title: "Thailand — practical basics",
    category: "destinations",
    text: "Bangkok's BTS and MRT skytrains avoid the city's legendary traffic; river boats serve the old centre. The rainy season peaks September–October with short heavy downpours. Thai temples require covered shoulders and knees and shoes removed at doors. Getting a motorbike licence from home is needed to ride legally, and travel insurance must cover it. Songthaews and Grab cover intercity and local hops; islands slow down considerably in the wet season.",
    tags: "bangkok bts mrt temple shoes rain season songthaew grab motorbike islands phuket chiang mai thailand",
  },
  {
    id: "bali-basics",
    title: "Bali and Indonesia — practical basics",
    category: "destinations",
    text: "Bali's dry season runs roughly April to October. Traffic around Seminyak and Canggu is dense — consider staying near what you plan to do. Scooter rental requires an international driving permit; police checkpoints are common. Hindu ceremonies regularly close roads with processions; dress respectfully and follow local detours. Ferries connect the islands but schedules shift with sea conditions. Tap water is not drinkable — use refill stations, now common in cafés.",
    tags: "bali dry season scooter seminyak canggu ceremony ferry island indonesia water ubud",
  },
  {
    id: "dubai-etiquette",
    title: "Dubai / UAE — laws and etiquette",
    category: "culture",
    text: "The UAE is welcoming but conservative: public displays of affection, swearing and rude gestures in public can lead to trouble, and alcohol is served only in licensed venues and hotels — public intoxication and drinking while driving are serious offences. Dress modestly away from beaches and pools; cover shoulders and knees in malls and mosques. Friday is a weekend day and many shops open later on Friday morning. Photography of people, government buildings and airports without permission is not allowed.",
    tags: "dubai uae law etiquette alcohol public affection mosque dress modest weekend friday photography rules",
  },
  {
    id: "walking-cities",
    title: "Exploring cities on foot",
    category: "transport",
    text: "Walking plus public transport beats driving in most old cities: central streets are narrow, parking is scarce and expensive, and one-way systems defeat sat-navs. Plan a loop each day anchored on one neighbourhood to cut backtracking. Comfortable shoes matter more than itinerary optimisation. Many cities offer free or paid walking tours where the guide works for tips — a cheap way to learn layout and history in the first hours. Midday in summer is best spent indoors at museums.",
    tags: "walking tour loop neighbourhood shoes public transport drive parking old city explore city centre",
  },
  {
    id: "museum-tips",
    title: "Museums and landmarks — visiting smart",
    category: "attractions",
    text: "Book timed-entry tickets online for headline sights — it skips queues and often guarantees entry when walk-ups cannot. Free-hour evenings at major museums exist in many cities and are far calmer than mornings. Start with the rooms you care about most; museums reward two visits more than one exhausted one. Cloakrooms handle large bags. Security checks add time at government buildings and religious sites, so travel light on those days.",
    tags: "museum timed entry ticket queue free evening cloakroom security landmark gallery visit booking attraction",
  },
  {
    id: "weather-reading",
    title: "Reading a forecast like a local",
    category: "planning",
    text: "Percent chance of rain means it may rain somewhere in the area for some of the time — not that you will lose the whole day; short showers are common in tropical afternoons. High temperature with high humidity feels far hotter than the number suggests. Wind speed matters more than expected for boats, rooftop bars and coastal towns. Mountain and coastal microclimates diverge sharply from the regional forecast, so check the town you will actually be in.",
    tags: "forecast rain percent humidity wind heat microclimate mountain coast weather reading planning",
  },
  {
    id: "trip-planning-order",
    title: "Order of operations when planning a trip",
    category: "planning",
    text: "Fix destination and dates first because everything else prices off them. Then lock the two biggest blocks — long-distance transport and accommodation — because they constrain the rest. Next sort must-do activities that need advance booking (permits, timed tickets, guides), and only then fill free time. Leave one unplanned half-day per week of travel; it absorbs delays and becomes the highlight people remember. Keep all confirmations offline in one folder.",
    tags: "planning order destination dates transport accommodation booking permits sequence itinerary steps organize",
  },
];
