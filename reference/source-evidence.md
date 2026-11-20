# StudyFetch source evidence

Public sources retrieved 2026-11-19. The onboarding route itself returns Cloudflare 403 to HTTP requests; its appearance is documented by native-browser screenshots separately.

## Exact public design tokens

- Main background: `#f7f6ef`
- Foreground: `#191919`
- Card: `#ffffff`
- Border / input: `#e5e5e5`
- Muted foreground: `#716d66`
- Secondary: `#eceae0`
- Pink: `#f5d5ff`; light pink: `#fbf0ff`
- Blue / teal: `#bbeef0`
- Peach: `#ffca98`
- Lemon: `#f9f284`
- Lime: `#bcf887`
- Radius tokens: 4 / 6 / 8 / 12 / 16 / 24 / 32 / 40px / full.
- Sans: Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif.
- Heading: Bitter, ui-serif, Georgia, Cambria, Times New Roman, Times, serif. Chinese falls through to platform serif.
- Monospace: JetBrains Mono.

Sources:
- https://www.studyfetch.com/_next/static/immutable/chunks/3v3k1_vh6k03c.css
- https://www.studyfetch.com/_next/static/immutable/chunks/301cq6kmdjvfy.css
- https://www.studyfetch.com/_next/static/immutable/chunks/10m54zqcxzjf1.css

Full light-theme variable map is in `reference/design-tokens.json`.

## Original onboarding routes / state names

Verified from public JS:
https://www.studyfetch.com/_next/static/immutable/chunks/1bu48tcggjghl.js

Student flow:
`language_selection → user_type → studying → how_you_heard → student_upload → student_processing → paywall → student_study_plan`

Default flow:
`language_selection → user_type → studying → how_you_heard → learning_goals → upload → name_study_set → features → generate_output → paywall`

Teacher flow: the default flow excluding upload, name_study_set, features, generate_output and paywall.

Parent flow:
`language_selection → user_type → how_you_heard → features → parent_intro → parent_gift`

An experiment `exam-first` exists, but the supplied URL and screenshots match the default student onboarding.

## Downloaded assets

Assets reside in `public/assets/studyfetch/`. `sources.json` maps original filenames to the verified source URL. Four original variable fonts and brand SVGs were downloaded via ordinary public HTTP.

- Upload: `upload-materials.svg`
- Brand: `studyfetch-avatar.svg`, `studyfetch-wordmark.svg`, `studyfetch-wordmark-dark.svg`
- All primary modality icons (notes, flashcards, study-path, quizfetch, tests, etc.)
- Mascot variants (sparke-avatar, sparke-running, sparke-reading, sparke-perched, etc.)
- Material file icons (PDF-v2, DOC, Image, Topic, etc.)
- Original social SVGs: social-2 = Instagram, social-3 = X, social-4 = LinkedIn, social-5 = YouTube, social-6 = TikTok.
- Simple Icons v13 fallback logos: source-pinterest, source-facebook, source-reddit, source-google, source-openai. Source is `https://cdn.jsdelivr.net/npm/simple-icons@v13/icons/{name}.svg`.

The `home-features-sparke-owner.svg` artwork is a person petting the dog, not the paywall student-at-desk artwork. Do not substitute it when claiming an exact replica.


## Exact inline vectors and game previews

- `student-at-desk.svg`: extracted from the saved original chunk `0nmjrzis1jarl.js`, inline SVG with aria label `Student studying at a desk`. This is the exact paywall artwork.
- `pictogram-{flashcards,quizzes,test,tutor-me,audio-recap,chat,read,arcade,explainers,qbank}.svg`: extracted from `2lqnk89lh5s46.js`, module 438423 / `ModalityPictogram`. These are the dashboard pictograms, including the actual open-book `read` graphic. The separate public `notes.svg` depicts a folded sheet and is not a substitute.
- `sparke-tail-wag.svg` is the sitting-dog empty-state illustration with green oval. `sparke-icon.svg` is a mouse pointer, not a mascot avatar.
- `game-create-{1,2,3}.png`: originals at `https://www.studyfetch.com/game_create_{1,2,3}.png`. Creation art layout comes from chunk `3957v_enyi3-g.js`, `GamePreviewPlaceholder`: 250×160px cards at y=0/130/260, rotated 6.426°/−9.939°/4.535°, radius19.895px.
- Arcade template thumbnail registry from the same chunk uses `https://studyfetchcdn.studyfetch.com/features/arcade/`; `match-game.png` downloaded as `game-match.png`.
- `sparky-qr.svg` is generated locally and points to the original official homepage; it is not the source-exact QR code.

## Captured first-screen tool flows

Native-browser references 12–14,18–19,25–31 govern the chat, flashcards, practice, Tutor Me, live lecture, audio recap and arcade first screens and creation source pickers. Layout, original labels and exact available illustration assets were retained. Local K12 content replaces user/course content.

Exact registered source routes include `/platform/studyset/{id}/audio-recap-v2`, `/audio-recap-v2/create`, `/arcade`, and `/arcade/create` (chunk `0ft0d10u9-78c.js`). `/audio-recap` is not the current source route.

Source monthly subscription constants in `3nd9aoqx3682s.js`: Max monthly50/yearly225; Premium monthly19/yearly96 (USD). UI is a local demonstration without a payment backend.

## Intentional local behavior and limits

- Creation steps after the captured first screen use local K12 example content, manual cards and browser storage. They are not asserted to match unseen authenticated source flows pixel for pixel.
- Chat sends a truthful service-unavailable response until an AI backend is configured. Guided Tutor Me lessons are labeled preset examples.
- Audio uses browser speech synthesis, explicitly labeled; recordings use MediaRecorder after the consent action and browser microphone permission. No simulated AI generation, transcription or automatic upload occurs.
- Arcade gallery has the source four-column card structure with playable K12 matching examples. It does not copy community user names, popularity or plays. 3D running/racing game engines are not implemented. The creation panel uses the exact original preview art, while the mode selection explains the available local matching game.
- Scores and flashcard mastery derive from actual answers/actions. Results are local only. Generic sample completion does not mark unrelated fine-grained curriculum topics as mastered.
- The dashboard monitor cover was subsequently obtained from `reference/studyfetch-dashboard_files/design-home-dashboard-02.png` (saved original image, `alt="My First Study Set"`), copied as `studyset-cover.png`.


## Reading reference 34

The reading article first screen is aligned to native screenshot `34-read.png`: a narrow cream article column, small reading label, large serif title, estimated reading time, a working browser-listen button, source chip and separator, then serif article sections. Article body remains the local K12 example text rather than the original generated prose. Reading time is derived from the actual local text. The menu supports marking as read and starting cards/quizzes. Browser listening is explicitly labeled when started.

Primary science now has its own five-card / five-question sample pack, `科学观察与生活`, covering measuring length, plant needs, water/ice, magnets and day/night. Primary science no longer falls back to secondary biology or mathematics.
