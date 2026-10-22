---
sidebar_position: 9
title: Live Activity Card
---

# Live Activity Card

A separate diagnostic feed for traffic that a chat card does not show: adverts,
newly discovered contacts, repeater status and telemetry responses, neighbour
responses, path changes, login results, packet observations, and companion errors.
It uses the existing `meshcore_raw_event`, `meshcore_connected`, and
`meshcore_disconnected` Home Assistant events. It does not send radio commands,
poll devices, or change integration settings.

## Install

The card is a standalone JavaScript file; it does not require reinstalling the
integration or removing any configured devices. In the **Home Assistant container
console** (where `/config` contains `configuration.yaml`), run:

```sh
python3 - <<'PY'
from pathlib import Path
from datetime import datetime
import urllib.request

folder = Path('/config/www')
folder.mkdir(parents=True, exist_ok=True)
target = folder / 'meshcore-activity-card.js'
url = 'https://raw.githubusercontent.com/clausefoto/meshcore-ha/main/cards/meshcore-activity-card.js'
with urllib.request.urlopen(url, timeout=60) as response:
    content = response.read()
if b'customElements.define("meshcore-activity-card"' not in content:
    raise RuntimeError('Unexpected download. Existing file unchanged.')
if target.exists():
    backups = Path('/config/meshcore-backups')
    backups.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    (backups / f'activity-card-{stamp}.js').write_bytes(target.read_bytes())
temporary = target.with_suffix('.js.tmp')
temporary.write_bytes(content)
temporary.replace(target)
print('Installed /config/www/meshcore-activity-card.js')
PY
```

If you prefer downloading files yourself, copy `cards/meshcore-activity-card.js`
from this repository to `/config/www/meshcore-activity-card.js`.

In Home Assistant:

1. Enable **Advanced mode** in your user profile if the Resources menu is missing.
2. Open **Settings → Dashboards → top-right menu → Resources**.
3. Add a resource with URL `/local/meshcore-activity-card.js?v=1` and type
   **JavaScript Module**. For YAML-managed resources use `type: module`.
4. Edit your dashboard, choose **Add card → Manual**, and paste:

```yaml
type: custom:meshcore-activity-card
title: Mesh activity
max_events: 150
height: 480
```

Refresh the browser if it reports that the custom element does not exist. If
`/config/www` was created for the first time, restart Home Assistant so `/local`
is registered. Later card-file updates normally need only a browser refresh;
increment the URL to `?v=2`, etc. to bypass cached versions.

## Use

- **All diagnostics / Adverts / Repeater responses / Packets / Errors / Connection**
  filters the retained feed.
- **Pause** freezes collection; events received while paused are discarded.
- **Clear** empties this card's buffer.
- Expand a row for the raw event JSON, including additional telemetry and status
  fields. Signal strength, SNR, hop count and path appear when supplied by the event.
- Known contact names are resolved from existing HA entity attributes when possible.
  Unknown or encrypted packets may have no identifiable sender. The card does not
  claim that every packet came from a repeater.

The feed is **live only**: it starts when the card is mounted, holds at most 150
entries by default, and is lost on a browser refresh. It does not backfill past
events, write a history sensor, or add database records. It shows events exposed by
the companion and integration, not every packet transmitted throughout the mesh.
A packet observation and its decoded response can appear as separate rows.

Chat receive events and RX_LOG packets identified as direct or channel text/data
are hidden. Routine local battery queries, contact-table downloads, queue checks,
and command acknowledgements are hidden too. Diagnostic errors may describe local
companion operations as well as radio problems. Debug logging is not required.
Raw JSON is truncated to 12,000 characters per row to bound memory use.

## Options

| Option | Default | Purpose |
|---|---|---|
| `title` | Mesh activity | Heading |
| `max_events` | 150 | Retained events, 10–500 |
| `height` | 480 | Scroll area height in pixels, 200–1200 |
| `entry_id` | All entries | Optional integration entry ID to show one companion only |

With more than one companion, add `entry_id` to avoid mixing their feeds.
Subscription failures appear on the card; check the Home Assistant user's event
subscription permissions and refresh to retry. No external frontend dependencies
or third-party scripts are loaded.

Developer checks: `node --check cards/meshcore-activity-card.js` and
`node --test tests_frontend/activity-card.test.cjs`.
