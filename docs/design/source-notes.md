# source notes: habits, rewards, and the app

compiled 2026-09-07 from the transcription import of 2026-09-06/07 into `Obsidian/My Outputs/Transcriptions/`, plus the older habit transcriptions already in the vault. this file is the reference layer: every note that feeds the habit list, the reward system, or the app lives here with its extracted signal. use it as the working doc for three decisions:

1. the final habit list
2. how the reward system plugs in
3. what the mobile app must do

nothing in this file is a decision. decisions go into [[habits-v2]] and [[rewards-and-coins]].

---

## the two anchor notes from the new import

### [[Developing Natural Habits and Routines]] (2026-08-22) - the habit-list note

the most direct statement of what he wants the system to hold:

- stop working before midnight, and make it feel natural, not rule-enforced
- wake up early; waking late = "telling your brain you are not in control"
- morning sequence: prayer first, spoken brain dump as soon as awake (produce before consuming), reflect on yesterday in obsidian, know the day's plan (work blocks, gym, evening) before touching work
- the first work item should already be planned the night before
- the wording problem: habits must be phrased as checkable actions, atomic-habits style
- the tracking problem: "there's no incentivization for me to track things" - streaks alone never motivated him because he never tracked
- the build decision, in his own words: "i'll also actually build my own habit tracking app because i've found no success in other ones. something that aligns with atomic habits, but also doesn't have a paywall."

### [[New Room Habits Rent and Project Challenges]] (2026-09-01) - the reward-system note

the systemization / reward note he referenced:

- two personal projects named: "habits/point system" and a private chalant event
- the point system should be **embedded within the habit tracker**, not a separate thing
- deep work sessions are the first thing rewarded
- "i want every reward to be earned"
- run it **manually first**: "i think it's best to do it manually now... i won't know how well it would impact me until i actually have something set up"
- context: new own room in toronto = "no more excuses" moment for sleep/wake habits
- side wish: dedicate the third display to time tracking (calendar, pomodoro)

---

## supporting notes from the new import

### [[Second Brain Dump Session Daily Frustrations and Goals]] (2026-08-08)

- late nights are eroding the morning: slept 2:50, went straight to messages on waking
- he used to keep the phone on do-not-disturb until noon; the morning buffer is the thing to restore
- keystone quote: "do not stay awake for a task that you won't wake up early for"
- late-night eating (the cereal) directly caused the late night

### [[Poor Sleep and Unhealthy Eating Habits]] (2026-07-26)

- phone in bed (reels) delays sleep; supports the bed habit's "phone out of reach" clause
- the "processed food only outside the house" rule fails when food is free and available; he wants a pre-decided limit for eating out
- principle he lands on: a habit should still work when the environment changes

### [[Reflections on living in Toronto]] (new import)

- social habit candidates, phrased as rules: start at least one conversation on the train, have at least one interaction on a walk
- "these habits need to start now. there's no waiting. clock is ticking, and i am paying."
- these are concrete instances of the existing optional **courage** habit, not new boxes

### [[Brain Dump Dreams and Content Creation Strategies]] (new import)

- wants filming to be a daily routine, decoupled from the decision to publish: "i'll film every day"
- a candidate habit, but a content-pipeline one - probably out of scope for the keystone system

### [[AI Intent App Development and Personal Reflections]] (new import)

- confirms the habit tracking app is a standing unbuilt project ("prompts i have to review, like my habit tracking app that i have yet to build")

---

## the source video for the reward system

**"I built a habit system as addicting as a casino" (SpoonFedStudy, 2026-04-23)**

- full transcript: `knowledge-base/Raw/Sources/YouTube/I built a habit system as addicting as a casino.md` (also at the iCloud knowledge-base vault root)
- url: https://www.youtube.com/watch?v=Qji8_5XgMW4
- this is the video [[coin-casino]] and [[rewards-and-coins]] were built from (adopted 2026-07-07)
- key mechanic: convert distracting rewards into conditional, variable rewards for meaningful actions (the maybe > the guarantee)
- transcript sections cover: power of the maybe, the coin flip example, near-miss phenomenon, the three rules for rewards, the wheel, bonus rounds, progress bars for real life
- triage verdict in the file's frontmatter: one usable mechanic, casino framing overbuilt, risk of procrastination-by-setup - which is why v1 kept it to one jar, one die, three reps

## older transcriptions worth keeping in view

- [[Reflecting on Ideal Daily Habits and Today's Challenge]] (2026-01-18) - early sketch of the ideal day; predecessor of the morning/night design
- [[Reflecting on Habits and Intentionality]] (2026-01-19) - habits framed through intentionality
- [[Reflections on Self Respect Time and Habits]] (2026-07-19) - proposes a monetary intentionality penalty; frames wasted time as a self-respect problem; morning songs/quran/poetry as emotional anchors
- [[Research Questions and Daily Habits]] (2026-07-25) - open questions incl. positive bedtime states and creative night rituals
- [[A Relapse into Old Habits]] (2026-07-11) - the dopamine/relapse loop the reward system must not feed
- [[My Habits]] (vault, `My Habits/My Habits.md`) - the historical habit attempts and ideal-day brainstorm; slightly outdated per project claude.md

---

## how the new notes map onto the existing system

the six boxes in [[habits-v2]] already cover almost everything the new notes ask for:

| note signal | existing box |
|---|---|
| stop work before midnight, plan tomorrow's first block | **closed** |
| sleep earlier, phone out of reach | **bed** |
| wake early, feel in control | **wake** |
| prayer + spoken dump before any input | **dump** |
| planned first block before reactive input | **ignition** |
| train conversation, walk interaction | **courage** (optional) |

new candidates the notes raise that are NOT covered:

- a food limit when eating out (poor sleep note) - likely a rule in the principles file, not a checkbox
- daily filming (brain dump note) - content pipeline, separate system
- third-display time dashboard - environment design, not a habit

### the reward-system overlap

[[rewards-and-coins]] and [[coin-casino]] already define exactly what the 2026-09-01 note asks for: deep work rewarded, every reward earned, points (coins) tied to the tracker's reps. the note independently re-derives the design. two things the note adds:

1. explicit instruction to run it **manually before automating** - which matches the coin jar being physical in v1
2. explicit instruction that the point system lives **inside the habit tracker** - which constrains the app spec: the app is tracker + ledger in one, not two tools

### the app requirements, consolidated from all notes

- one screen, the six boxes, binary checks ([[habits-v2]] spec)
- votes per box per week, not streaks ([[habits-v2]])
- never-miss-twice alert as the only notification ([[habits-v2]])
- coin ledger embedded: earning events per [[rewards-and-coins]], rolls per [[coin-casino]] (new-room note)
- aligned with atomic habits, no paywall, personal-use first (developing-natural-habits note)
- mobile (this session's goal)

### open tensions to resolve together

1. [[habits-v2]] gates any app behind 30 days of paper tracking in the daily note. building the mobile app now breaks that gate. options: honor the gate, shorten it, or treat the app itself as the manual v1 (checks only, no automation).
2. [[habits-v2]] app spec says no points in the ui; the new-room note says points belong inside the tracker. decide: checks-only v1 with coins staying physical, or coins in-app from day one.
3. digitizing the casino roll removes the physical die/jar ritual that makes it satisfying. decide what stays physical.
