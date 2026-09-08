# Setup on a new machine

Use Node 20 or newer. Clone the submitted repository into a new directory, then run:

```bash
git clone https://github.com/surya16122114/ledgerhand.git
cd ledgerhand
npm ci
npx playwright install chromium
cp .env.example .env
npm run typecheck
npm test
npm run build
```

The clone contains only committed files. These checks must be repeated after the final submission changes have been committed and pushed.

The example environment contains synthetic application credentials. Set your own `OPENAI_API_KEY` for discovery and chat; neither deterministic replay nor dashboard invocation needs it. Never commit `.env` or a model key.

In one terminal, run `npm run target-app`. In another terminal in the same directory:

```bash
npm run demo:replay
npm run test:browser
npm run cli -- serve --headed
```

Open http://127.0.0.1:4190/ and follow the [README demonstration](../README.md#dashboard-demonstration). Local applications use ports 4173 and 4174. Hosted Meridian also needs an internet connection; local test success does not verify the hosted service.

## Troubleshooting

| Symptom | Check |
|---|---|
| Connection refused on 4173 or 4174 | Start the local target app and inspect its terminal output. |
| A run waits without completing | Open its operator link: it may be waiting for a decision. |
| Port already in use | Stop the specific previous server in its terminal, or choose an available port with the command's port option. |
| Missing credential | Check the relevant variables in `.env` against `.env.example`; preserve any existing model key. |
| Browser executable missing | Run `npx playwright install chromium`. |
| Chat unavailable | Check model provider and key; the dashboard can still invoke saved capabilities. |
| `npm ci` fails | Read the reported error; check Node version, registry access and lockfile consistency. |
| Missing write confirmation | Inspect run evidence and reconcile target state before another write. |

A screenshot or DOM snapshot is expected for browser failures and escalations, not every success or input rejection. `run.jsonl` contains ordered events; `summary.json` contains the terminal run summary; verification scripts may also write an outer `result.json`.
