# Infominer Tally sync agent

A small program that runs on each PC with Tally. Every minute it tells the portal which companies Tally has open; the portal answers with what to sync (every 2 hours for the current FY, daily for last FY, and immediately when a client presses **Request fresh data**). It only sends **Export** requests to Tally, so it cannot change your books.

## What it reads

For each linked company and financial year: groups, ledgers (with GSTIN), month-end closing balances, stock value, and every voucher (excluding cancelled and optional ones). The portal re-checks the data on arrival:

- the trial balance tallies at every month end,
- every voucher balances,
- opening balance + vouchers equals Tally's own closing balance for every ledger.

Any failure is shown to staff as a warning on the company's Reports tab.

## Install on a Windows PC

1. **Tally:** TallyPrime › F1 Help › Settings › Connectivity › *TallyPrime acts as* **Server**, port **9000**. (Tally.ERP 9: F12 › Advanced Configuration › *Tally.ERP 9 is acting as* **Server**.)
2. **Node.js:** install the LTS version from nodejs.org (version 20 or newer).
3. In the portal, **Tally sync › Add a Tally PC**, then download `agent.json` and the agent program. Put both, plus `install-agent.ps1`, in `C:\Infominer`.
4. Open PowerShell and run:
   ```
   powershell -ExecutionPolicy Bypass -File C:\Infominer\install-agent.ps1
   ```
   It tests the connection once, locks `agent.json` to the current user, and registers a task that starts the agent at sign-in and restarts it if it stops.
5. Back in the portal, link each Tally company to its client under **Tally sync**.

Tally must be open with the company loaded for a sync to happen. If the PC is off, requests wait and run when it is back.

## Files

| File | Purpose |
| --- | --- |
| `agent.json` | Portal URL and this PC's key. Treat it like a password. |
| `agent.log` | What the agent did; rotates at 5 MB. |

## For developers

```bash
npm run agent:build          # builds agent/dist/infominer-agent.mjs (one file, no dependencies)
npm run mock-tally           # Tally simulator on :9000 with two years of sample books
node agent/dist/infominer-agent.mjs path/to/agent.json --once
```

Source: `agent/src/tally.ts` (XML client), `agent/src/sync.ts` (snapshot builder), `agent/src/index.ts` (loop).
