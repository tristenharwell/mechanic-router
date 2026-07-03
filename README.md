# Mobile Mechanic Route Planner

Plans and optimizes multi-day driving routes for a mobile mechanic. Runs entirely in
your browser — no installs, no accounts, no API keys. Your data stays on your computer
(saved in the browser's local storage).

## Starting the app

Double-click **`Start Route Planner.cmd`** — it starts a tiny local server and opens the
app in your default browser.

(Alternative: double-clicking `index.html` directly also works in Chrome/Edge.)

## Daily workflow

1. **Settings** — enter your home base address, workday start time, and workday length once.
2. **Import customers** — see below.
3. **Jobs to schedule** — pick a customer, describe the job, estimate its duration in minutes.
4. Click **⚡ Optimize Routes**. The app:
   - looks up each address on the map (free OpenStreetMap-based geocoders),
   - gets real road drive times between all stops (OSRM),
   - packs jobs into as few workdays as possible without exceeding your workday length,
   - orders each day's stops to minimize driving (nearest-neighbor + 2-opt),
   - shows arrival/departure ETAs for every stop and draws each day's route on the map.
5. Use the **Day 1 / Day 2 / …** tabs to flip between days, and **🖨 Print schedule** to
   print the day sheet for the truck.

## Sending a route to your phone

Click **📱 Send day to phone (Google Maps)** above the day's schedule, then scan the QR
code with your phone camera — the whole day opens in Google Maps navigation with every
stop in order. You can also copy the link and text it to yourself. Days with more than
9 stops are split into consecutive links (Google's limit), each one starting where the
last ended. Every stop card also has a **🧭 Navigate** button for one-off directions.

## Notifying customers when you're en route

Each stop card has a **💬 Notify customer** button. It composes a message from your
template (edit it under Settings — placeholders: `{first}` `{name}` `{job}` `{eta}`
`{address}` `{vehicle}`), filled with that stop's ETA. Then:

- **Copy message** — paste it anywhere,
- **Text from this device** — opens your messaging app (works great if you run the
  planner on your phone),
- **scan the QR code** — opens your phone's SMS composer pre-filled with the customer's
  number and message, so you can send with one tap,
- **Email** — if the customer has an email on file (imported from ALLDATA or added manually).

## Getting customer data out of ALLDATA

ALLDATA Manage Online has no public API, so the app reads its CSV exports:

- **Customer & vehicle export**: in Manage Online, ask your ALLDATA account manager to
  enable *Shop Data Export* (viewable under **Setup » User Options » Generic Export**),
  or use the customer/vehicle data export in your version's Setup menu.
- **Invoice history export**: **Setup » User Options » Invoice History Export** also
  produces a CSV that includes customer names and addresses.

Then in the app: **Import customers » Choose CSV file…** (or paste the CSV text).
The app auto-detects columns (name, address, city, state, ZIP, phone, vehicle) and asks
you to confirm. **Re-import any time to refresh** — existing customers are matched by
name + address and updated in place, never duplicated.

## Notes & limits

- Internet connection required (map tiles, geocoding, drive times).
- Free routing services (OSRM demo server, Photon/US Census/Nominatim geocoders) are
  fine for a single shop's daily volume; they are not guaranteed-uptime commercial services.
  If one geocoder is down, the app automatically tries the next.
- Drive times are typical road speeds without live traffic.
- Address lookups are cached locally, so re-planning is fast and only new addresses
  hit the network.
