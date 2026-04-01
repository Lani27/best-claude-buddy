# best-buddy

Find the highest-stat Claude Code companion matching your exact preferences. Scans millions of PRNG seeds to find the optimal salt, patches the binary, and saves your custom name and personality.

Forked from [buddy-reroll](https://www.npmjs.com/package/buddy-reroll) — the original tool that figured out the companion salt patching system. This project extends it with stat optimization, custom naming, and personality control.

Requires [Bun](https://bun.sh).

## Quick start

```bash
# Clone and run
git clone https://github.com/Lani27/best-claude-buddy.git
cd best-claude-buddy

# Find and apply the best legendary dragon with max stats
bun best-buddy.js --species dragon --eye ✦ --hat crown --name "Sparky"

# Preview without patching
bun best-buddy.js --species ghost --shiny --dry-run
```

## Why not just use buddy-reroll?

`buddy-reroll` finds the **first** salt that matches your visual criteria. It doesn't care about stats — a 339-total and a 420-total companion look the same to it.

`best-buddy` scans **50 million salts** (in ~20 seconds) and finds the one with the **highest total stats** for your exact combination. It also lets you set a custom name and personality instead of getting a random one.

## Flags

All flags are optional. Omit any to leave it unconstrained.

### Appearance

| Flag | Values |
|------|--------|
| `--species` | duck, goose, blob, cat, dragon, octopus, owl, penguin, turtle, snail, ghost, axolotl, capybara, cactus, robot, rabbit, mushroom, chonk |
| `--rarity` | common, uncommon, rare, epic, legendary *(default: legendary)* |
| `--eye` | `·` `✦` `×` `◉` `@` `°` |
| `--hat` | none, crown, tophat, propeller, halo, wizard, beanie, tinyduck |
| `--shiny` | flag (use `--no-shiny` to exclude) |

### Stats

| Flag | Values |
|------|--------|
| `--peak` | DEBUGGING, PATIENCE, CHAOS, WISDOM, SNARK *(which stat is guaranteed 100)* |
| `--dump` | DEBUGGING, PATIENCE, CHAOS, WISDOM, SNARK *(which stat is the lowest)* |

### Identity

| Flag | Description |
|------|-------------|
| `--name` | Custom name — any string you want |
| `--personality` | Custom personality sentence — controls how speech bubbles sound (max 200 chars) |

### Options

| Flag | Description |
|------|-------------|
| `--scan` | Number of salts to scan (default: 50,000,000) |
| `--dry-run` | Preview results without patching the binary |
| `--list` | Show all available options |
| `--current` | Show current companion and stats |
| `--restore` | Restore original binary from backup |
| `-h, --help` | Show help |

## Examples

```bash
# Show all available options
bun best-buddy.js --list

# Show your current companion
bun best-buddy.js --current

# Find the best legendary cat with WISDOM as highest stat
bun best-buddy.js --species cat --peak WISDOM --name "Professor Whiskers"

# Shiny ghost with custom personality
bun best-buddy.js --species ghost --eye ✦ --hat crown --shiny \
  --name "Ghosty" \
  --personality "Haunts your codebase and gasps at every runtime error"

# Scan more salts for rarer combos (takes longer)
bun best-buddy.js --species dragon --shiny --peak CHAOS --scan 200000000

# Undo everything — restore original binary
bun best-buddy.js --restore
```

## How it works

### Companion generation

Claude Code companions are generated from a deterministic PRNG (`mulberry32`) seeded by `hash(userId + salt)`. The salt is a 15-character string embedded in the Claude binary. Given the same salt and user ID, you always get the same species, eyes, hat, stats, and shiny status.

### Stat ranges by rarity

| Rarity | Floor | Peak stat | Dump stat | Other stats | Theoretical max total |
|--------|-------|-----------|-----------|-------------|----------------------|
| Common | 5 | 55-84 | 1-19 | 5-44 | 217 |
| Uncommon | 15 | 65-94 | 5-29 | 15-54 | 286 |
| Rare | 25 | 75-100 | 15-39 | 25-64 | 356 |
| Epic | 35 | 85-100 | 25-49 | 35-74 | 396 |
| Legendary | 50 | 100 | 40-54 | 50-89 | 421 |

- **Peak stat**: one random stat gets boosted — always hits 100 for legendary
- **Dump stat**: one random stat (different from peak) gets penalized
- **Other 3 stats**: roll within the rarity's range

### What this script does

1. Scans millions of salts through the same PRNG
2. Filters for rolls matching all your criteria
3. Ranks by total stat points
4. Patches the binary with the optimal salt (creates a `.backup` first)
5. Writes the companion config with your custom name and personality

### Name and personality

Normally, Claude Code generates the companion name using `crypto.randomBytes()` (truly random, changes every hatch) and the personality via a Haiku LLM call using your stats as input.

This script bypasses both by writing the `name` and `personality` fields directly into the config file (`~/.claude.json`). Claude Code reads these from the config and uses them as-is.

### How personality affects speech bubbles

The personality string is sent to Anthropic's API on every bubble reaction:

```
personality: "Haunts your codebase and gasps at every runtime error"
```

The server uses it as the companion's "character" when generating bubble text. Higher SNARK stats with a snarky personality = very snarky bubbles. A cheerful personality with high WISDOM = encouraging, knowledgeable comments.

The personality is truncated to 200 characters by the API. Stats don't change bubble **frequency** — they only change the **tone and content**.

### Restore

If anything goes wrong, or you want to go back to your original companion:

```bash
bun best-buddy.js --restore
```

This copies the `.backup` file over the binary and clears the companion config. The backup is created automatically the first time you patch.

## How is this different from buddy-reroll?

| Feature | buddy-reroll | best-buddy |
|---------|-------------|------------|
| Find matching companion | First match | Highest stats |
| Custom name | No | Yes |
| Custom personality | No | Yes |
| Stat optimization | No | Scans 50M+ salts |
| Peak/dump stat control | No | `--peak` / `--dump` |
| Restore command | Yes | Yes |
| Interactive TUI | Yes | No (CLI flags) |
| Runtime | Bun | Bun |
