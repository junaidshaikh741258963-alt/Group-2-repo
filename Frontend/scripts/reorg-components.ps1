# Phase 1 reorg helper: move components into categorized subfolders.
# Safe to re-run: passes are idempotent (quoted exact-string replaces).
$ErrorActionPreference = "Stop"
$root = "C:\2. FODS Project\ai-travel-planner"
Set-Location $root

$map = [ordered]@{
  'AddToTripButton'    = 'ui';      'AirportField'      = 'ui';      'CategoryIcon'   = 'ui'
  'CountryPicker'      = 'ui';      'LocationInput'     = 'ui';      'SavePlaceButton' = 'ui'
  'SmartImage'         = 'ui';      'StarRating'        = 'ui';      'StationField'   = 'ui'

  'ChatFlightBar'      = 'chat';    'ChatHero'          = 'chat';    'ChatInput'      = 'chat'
  'ChatMessage'        = 'chat';    'ChatSidebar'       = 'chat';    'StructuredCards' = 'chat'

  'ExploreView'        = 'explore'; 'HotelCard'         = 'explore'; 'HotelDetailSheet' = 'explore'
  'HotelList'          = 'explore'; 'PlaceDetailModal'  = 'explore'; 'PlaceGallery'   = 'explore'
  'RecommendationCard' = 'explore'

  'ItineraryDisplay'   = 'trip';    'ItineraryTimeline' = 'trip';    'PlanBuilder'    = 'trip'
  'ProgressivePlanner' = 'trip';    'RoutePlanner'      = 'trip';    'TravelPlanningForm' = 'trip'
  'TripItinerary'      = 'trip';    'TripItemsContext'  = 'trip'

  'MapCard'            = 'map';     'MapClusterStack'   = 'map';     'MapPane'        = 'map'
  'MapView'            = 'map';     'PlaceMiniMap'      = 'map';     'TravelMap'      = 'map'

  'BookFlights'        = 'booking'; 'BookingPickers'    = 'booking'; 'BookTrains'     = 'booking'

  'AppShell'           = 'layout';  'BlackBackground'   = 'layout';  'Brand'          = 'layout'
  'Navbar'             = 'layout';  'SiteFooter'        = 'layout'

  'Hero'               = 'home';    'HeroMockup'        = 'home';    'HomeBackground' = 'home'
  'ShowcaseCard'       = 'home'
}

$utf8 = New-Object System.Text.UTF8Encoding($false)
$srcFiles = Get-ChildItem src -Recurse -File | Where-Object { $_.Extension -in ".ts", ".tsx" }

# Pass 1: relative "./X" imports of components -> absolute "@/components/X".
foreach ($f in $srcFiles) {
  $text = [System.IO.File]::ReadAllText($f.FullName)
  $orig = $text
  foreach ($name in $map.Keys) {
    $text = $text.Replace('from "./' + $name + '"', 'from "@/components/' + $name + '"')
    $text = $text.Replace('from "../components/' + $name + '"', 'from "@/components/' + $name + '"')
  }
  if ($text -ne $orig) { [System.IO.File]::WriteAllText($f.FullName, $text, $utf8) }
}

# Pass 2: "@/components/X" -> "@/components/<folder>/X".
foreach ($f in $srcFiles) {
  $text = [System.IO.File]::ReadAllText($f.FullName)
  $orig = $text
  foreach ($name in $map.Keys) {
    $text = $text.Replace('"@/components/' + $name + '"', '"@/components/' + $map[$name] + '/' + $name + '"')
  }
  if ($text -ne $orig) { [System.IO.File]::WriteAllText($f.FullName, $text, $utf8) }
}

# Pass 3: move the files.
foreach ($name in $map.Keys) {
  $folder = Join-Path "src\components" $map[$name]
  New-Item -ItemType Directory -Force -Path $folder | Out-Null
  $from = "src\components\$name.tsx"
  if (Test-Path $from) { Move-Item $from (Join-Path $folder "$name.tsx") }
  else { Write-Host "MISSING: $from (already moved?)" }
}

Write-Host "components reorganized: $($map.Count) files"
