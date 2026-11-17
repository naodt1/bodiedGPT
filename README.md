# BodiedGPT

**What does an AI do if it's given a body and freedom?**

BodiedGPT is an open experiment. A language model (OpenAI's GPT models, or any local model through [Ollama](https://ollama.com)) controls a person on a small low-poly 3D island. Nobody gives it a goal. You watch what it thinks, wants and does, alone or with a second AI that it is never told about. You can also read exactly what it was told at every step.

It runs entirely in the browser (Three.js + Vite). There is no backend.

---

## Contents

- [Quick start](#quick-start)
- [Running an experiment](#running-an-experiment)
- [Choosing a model](#choosing-a-model)
- [API key safety](#api-key-safety)
- [Deploying](#deploying)
- [What the AI is told](#what-the-ai-is-told)
- [Controls](#controls)
- [Project structure](#project-structure)
- [Troubleshooting](#troubleshooting)

---

## Quick start

Requirements: Node.js 18+ and a modern browser (Chrome, Edge, Firefox or Safari).

```bash
cd ~/Documents/Codes/GameDev/IslandMind-web
npm install
npm run dev
```

Open **http://localhost:5173**.

Then pick an AI provider:

- **Local (free):** install Ollama, run `ollama serve`, and pull a model:
  ```bash
  ollama pull llama3.2:3b     # ~2 GB, good balance
  ```
  Smaller and lighter: `phi3:mini`, `qwen2.5:1.5b`. Smarter but heavier: `llama3.1:8b`, `qwen2.5:7b`.
- **OpenAI (cloud):** choose **OpenAI** in the setup and paste an API key. See [API key safety](#api-key-safety) first.

## Running an experiment

The launch screen has two cards: an **about** card, and a step-by-step setup with **Back / Next**. The steps are Welcome (new or continue), **Subjects** (one or two, and their names), **Experiment** (name and conditions), **World** (start time), **AI** (provider and model), and **Review** (the full configuration and what each subject is told) → **Start experiment**.

The conditions:

| Setting | Options |
|---|---|
| **Subjects** | One (Finn) or Two (Finn and Mara, never told the other exists) |
| **Body needs** | On: they feel hunger and tiredness, described in words, never numbers. Off: no stats at all |
| **Behaviour** | **Action list:** picks one of walk_to, gather, eat, drink, rest, say, wait. **Free will:** no list; it writes what it wants, and the body does it if a body can (walk somewhere it can see, wander, sit) |
| **Provider / Model** | Local Ollama or OpenAI; the list shows the models actually available to you |
| **Start time** | Morning, midday, evening or night, plus date and clock speed. The sun and the AI's "light" description follow the clock |
| **Allow death** | With body needs on, starvation can kill. You can also end a subject's life manually (K K) to watch the other react |

Runs autosave every 30 seconds, on **Save**, when you go back to setup, and when the tab closes. Pick one under **Previous runs** to continue with the same memories, positions and in-world time. Saves are stored in your browser (localStorage).

## Research mode and reproducibility

**Method** settings (Experiment step):

| Setting | Effect |
|---|---|
| **Prompt style: Research (neutral)** (default) | The subject is told only facts: it is an AI controlling a human body called X, what the body looks like and can feel, that no one has given it a goal, and the available actions (or that there is no list). No personality, no "you notice you keep repeating…" hints, no instruction to answer you, no reflections, and its own notes are never edited. |
| **Prompt style: Characterful** | Personalities, gentle anti-repetition hints, guaranteed replies to the Player, reflections. Livelier for videos, but the output is partly shaped by these nudges. |
| **Temperature** | 0 / 0.4 / 0.7 / 1.0 for decisions. Lower is more predictable. |
| **Seed** | Sent to the model (Ollama `seed`, OpenAI `seed`) and used for the body's random choices (wandering). The same seed and setup give repeatable runs, as far as the model allows. |

**What makes perception and memory more faithful:**
- **Directions:** everything seen is given with distance and direction relative to where the subject faces (ahead, to your left, behind you…). Other people include what they are doing and whether they face you.
- **Surroundings:** high ground or not, trees around, where the sea and the lake are, and what the sky looks like.
- **Long-term memory:** every 12 decisions the subject rewrites a summary of everything so far, which is shown every turn along with the last 12 events.
- **Free will:** each wish is translated into a physical action by a separate, neutral request at temperature 0 (stay / walk to a visible place / wander / sit), instead of keyword matching. Keyword matching is used only as a fallback if that request fails.

**Exporting a run:** click **Export** in the top bar to download two files:
- `<experiment>.json`: the configuration (behaviour, subjects, needs, prompt style, temperature, seed, model, world time) and **every request**: system prompt, full context, raw reply, timing, model and seed, for every subject. That includes the wish-reader and memory-summary calls.
- `<experiment>.csv`: one row per decision, message and note, ready for a spreadsheet.

**Repeating a setup:** under *Continue a previous run*, the ↻ button starts a **new** run with the same conditions, method and seed, but fresh memories, and opens the Review step so you can check it first.

## Choosing a model

- **Local:** the setup asks your Ollama server which models are installed (`/api/tags`) and lists them. The status line shows `● Connected · N models`, or explains what's wrong.
- **OpenAI:** once your key is entered, the setup lists the GPT models your key can use and preselects the cheapest. It tries `gpt-4.1-nano` first, then `gpt-4o-mini`, then `gpt-4.1-mini`.
- You can change the model per subject mid-run in **Settings** (Tab).

**Rough cost with OpenAI:** about $0.10–0.20 per hour per subject on nano/mini models, and roughly $3 per hour on `gpt-4o`. Requests are queued one at a time.

## API key safety

BodiedGPT has no server. Your key never touches one.

- **Direct to OpenAI only.** The key is sent only from your browser to `https://api.openai.com`. The page's Content-Security-Policy (in `index.html`) only allows network requests to the site itself, `api.openai.com` and an Ollama server on `localhost`/`127.0.0.1`. Even injected code couldn't send it anywhere else.
- **Session-only by default.** The key is kept in `sessionStorage` and forgotten when you close the tab. It goes into `localStorage` only if you tick **Remember on this device**. **Forget** removes it immediately.
- **Never in saves or logs.** Saves contain memories and positions only. Errors are shown without the key.
- **Shown masked.** Once entered, the key appears only as `••••••••`.

**Recommendations:**

1. Create a **dedicated project key** at platform.openai.com with a **monthly budget limit**.
2. Restrict it to the models you use, if your organisation supports that.
3. Don't tick "Remember" on shared computers.
4. If you deploy publicly, visitors use **their own** keys. Never hard-code a key into the build.

## Deploying

The build is a static site:

```bash
npm run build      # outputs dist/
npm run preview    # test the production build at http://localhost:4173
```

Upload `dist/` to any static host (Vercel, Netlify, Cloudflare Pages, GitHub Pages, S3).

**Before deploying:**

1. Replace `https://bodiedgpt.vercel.app` with your real domain in `index.html` (canonical, Open Graph, Twitter, JSON-LD), `public/robots.txt` and `public/sitemap.xml`.
2. The social preview image `public/og-image.png` (1200×630) is included. To re-capture it after changing the look, open `http://localhost:5173/?og=1` (a staged, UI-free campfire scene) and screenshot it at 1200×630, for example with headless Chrome:
   `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --window-size=1200,630 --virtual-time-budget=6000 --screenshot=public/og-image.png "http://localhost:5173/?og=1"`
3. If your host lets you set HTTP headers, you can also serve the Content-Security-Policy from `index.html` as a header.

**Using local Ollama from the deployed site:** in the browser, the site talks to `http://localhost:11434` directly, since there is no dev proxy in production. Ollama rejects unknown websites (HTTP 403) unless you allow your domain:

```bash
OLLAMA_ORIGINS=https://your-domain.com ollama serve
```

On macOS with the Ollama app: `launchctl setenv OLLAMA_ORIGINS "https://your-domain.com"`, then restart Ollama. You can change the Ollama address in the setup (**Ollama address**). Some browsers (notably Safari) may block an `https` page from calling `http://localhost`; use Chrome/Edge/Firefox or the OpenAI provider in that case.

## What the AI is told

Transparency is part of the experiment:

- **In setup:** **What the subject is told** shows the exact system prompt for the chosen conditions, what arrives every turn, and how memory works.
- **During a run:** press **I** to open the **Inspector** for the followed subject. It has four tabs:
  - **Instructions:** the system prompt
  - **Context:** the full observation sent with the last decision
  - **Memory:** names known, feelings notes, deaths, reflections, events
  - **Last reply:** the raw model output for every request type

**Every turn, a subject receives:**
- the date, time and light level
- how its body feels (if needs are on)
- what it sees nearby. Other people are described only by looks and gender, and a name is known only once it's said out loud.
- what it just heard
- its last 8 events
- its private notes about others
- its last 3 reflections
- any death it witnessed
- a gentle "you notice…" if it keeps repeating itself
- your messages, placed last

**Memory:**
- **Reflection:** a one-sentence reflection every 10 decisions.
- **Notes:** a rewritten private note about another person every 8 decisions after contact.
- **Replies to you:** your messages get their own request, so a reply is guaranteed.

## Controls

| Key | Action |
|---|---|
| Enter | Talk to the subjects (everyone hears you) |
| Drag / wheel | Orbit / zoom |
| 1 / 2 / 3 | Speed 1× / 2× / 4× |
| Space | Pause |
| I | Inspector |
| Tab | Settings (name, personality, model, provider, date/time) |
| F | Switch which subject the camera follows |
| C | Slow auto-orbit |
| H | Hide panels (for recording) |
| K, K | End the followed subject's life |
| R | Back to setup |

Dev shortcut to skip the setup: `http://localhost:5173/?auto=free:2:off&provider=ollama` (behaviour : subjects : needs).

## Project structure

```
index.html          SEO meta, Content-Security-Policy, structured data
public/             favicons (SVG + PNG + Apple touch icon), robots.txt, sitemap.xml, web manifest
src/main.js         experiment loop, camera, keys, hearing, deaths
src/brain.js        providers (Ollama/OpenAI), request queue, prompts, memory, wish reader
src/character.js    body, animation, actions, free-will acting, steering
src/needs.js        hunger / tiredness / hidden health
src/people.js       the two subjects (looks, personality)
src/objects.js      trees, rocks, bushes, shelter, campfire, pier, lookout, bench, boat, flowers
src/terrain.js      island height function, ground mesh, water
src/nature.js       instanced grass with wind shader, clouds, sky and day/night lighting
src/hud.js          top bar, observation log, inspector, settings
src/menu.js         launch screen: about card + step-by-step setup, model picker
src/save.js         save / continue (localStorage)
src/icons.js        line icons
```

## Troubleshooting

| Problem | Fix |
|---|---|
| "Can't reach Ollama" | Run `ollama serve`. On a deployed site, set `OLLAMA_ORIGINS` (see [Deploying](#deploying)) |
| "Ollama is running but has no models" | `ollama pull llama3.2:3b` |
| "That API key was rejected" | Check the key and that billing is enabled on your OpenAI account |
| Subjects repeat themselves / invent names | Small local models do this; try a larger model or OpenAI |
| Low FPS | Close other GPU-heavy apps (a local model shares the GPU), or use OpenAI |

---

*Formerly "Island Mind". The original Godot prototype is in `../IslandMind`.*
