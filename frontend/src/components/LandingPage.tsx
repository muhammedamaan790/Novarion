// Public landing page, shown before sign-in (D-028): what problem NOVARION addresses and how. Layout adapted from
// Landwind by Themesberg (MIT, © 2022 Themesberg): navbar, hero with image, logo strip (here: facts), feature grid,
// content section, statement section and CTA; its footer is left out. Flowbite's script is not used and nothing loads
// from another origin. Icons from Heroicons (MIT, © Tailwind Labs), inline. The hero heart is the app's own reference
// anatomy (BodyParts3D, CC BY 4.0), explorable where the browser allows it (LandingHeart, D-031, D-036). Only dataset and
// method facts appear here: model figures need a session and are shown after sign-in, bound to the served model
// (audit R09).
import { DisclaimerFooter } from "./Chrome";
import { LandingHeart } from "./LandingHeart";

const ICONS = {
  warning: "M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z",
  search: "m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z",
  heart: "M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z",
  patient: "M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z",
  why: "M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z",
  check: "M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
} as const;

const FACTS = [
  ["303", "patients, each with an angiography result"],
  ["55", "routine clinical measurements per patient"],
  ["4", "predictions: overall CAD, LAD, LCX and RCA"],
  ["5 × 5", "nested cross-validation: each patient scored by models that never saw them"],
] as const;

const PROBLEM: { icon: keyof typeof ICONS; title: string; text: string }[] = [
  { icon: "heart", title: "The world's leading cause of death",
    text: "The WHO lists ischaemic heart disease, caused by narrowed coronary arteries, as the leading cause of death worldwide." },
  { icon: "warning", title: "Confirmed only by an invasive test",
    text: "Whether, and in which artery, there is a significant narrowing is settled by coronary angiography: a catheter passed to the heart, with contrast dye and X-rays." },
  { icon: "search", title: "Most elective tests find no blockage",
    text: "In a US registry of almost 400,000 elective angiographies, only about 4 in 10 patients had obstructive disease (Patel et al., NEJM 2010)." },
];

const STEPS: { icon: keyof typeof ICONS; title: string; text: string }[] = [
  { icon: "patient", title: "1. Enter the patient",
    text: "Age, risk factors, symptoms, ECG, echo and blood results: measurements a clinic already has. Type them, import a file, or open a dataset patient." },
  { icon: "heart", title: "2. See it on the heart",
    text: "Four calibrated probabilities, overall CAD and one for each main artery, coloured onto that artery of a 3D heart." },
  { icon: "why", title: "3. See why, and how sure",
    text: "Which measurements pushed each prediction up or down, how stable it is, and whether it falls in a range that held up in internal evaluation." },
];

const APPROACH = [
  "For each target, nested cross-validation picks among logistic regression, EBM, XGBoost and CatBoost (92 configurations fixed in advance), then calibrates the winner so a probability means what it says.",
  "Exact SHAP explanations: every prediction is split into the contribution of each measurement, shown beside the patient's own values.",
  "Honest uncertainty: a prediction is marked “high support” only inside a probability range whose accuracy met targets set before any results (PPV ≥ 90%, NPV ≥ 95%); everything else says it is outside that range.",
  "Built for review: a quality check on the inputs, a clinician's note, a hash-verified snapshot of what was seen, and a case history.",
];

function Icon({ d, className = "size-5 lg:size-6" }: { d: string; className?: string }) {
  return (
    <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5}
         stroke="currentColor" className={className}>
      <path strokeLinecap="round" strokeLinejoin="round" d={d} />
    </svg>
  );
}

const ARROW = "M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z";
const primary = "inline-flex items-center justify-center rounded-lg bg-emerald-700 font-semibold text-white hover:bg-emerald-800 focus:outline-none focus:ring-4 focus:ring-emerald-300";

export function LandingPage({ onSignIn }: { onSignIn: () => void }) {
  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  const navLink = "font-semibold text-slate-700 hover:text-emerald-700";
  return (
    <div className="flex h-full flex-col overflow-auto bg-white text-slate-900" data-testid="landing">
      <header>
        <nav aria-label="Landing" className="border-b border-slate-200 bg-white px-4 py-3 lg:px-6">
          <div className="mx-auto flex max-w-screen-xl flex-wrap items-center justify-between">
            <span className="text-xl font-extrabold tracking-[0.25em]">NOVARION</span>
            <div className="flex items-center lg:order-2">
              <button type="button" onClick={onSignIn} data-testid="landing-sign-in-nav"
                      className={`${primary} px-5 py-2.5 text-sm`}>
                Sign in
              </button>
            </div>
            <ul className="hidden gap-8 lg:order-1 lg:flex">
              <li><button type="button" className={navLink} onClick={() => scrollTo("landing-problem")}>The problem</button></li>
              <li><button type="button" className={navLink} onClick={() => scrollTo("landing-approach")}>Our approach</button></li>
              <li><button type="button" className={navLink} onClick={() => scrollTo("landing-how")}>How it works</button></li>
            </ul>
          </div>
        </nav>
      </header>

      <main className="flex-1">
        <section className="bg-linear-to-b from-emerald-50 to-white" data-testid="landing-hero">
          <div className="mx-auto grid max-w-screen-xl px-4 py-8 lg:grid-cols-12 lg:gap-8 lg:py-16 xl:gap-0">
            <div className="mr-auto place-self-center lg:col-span-7">
              <p className="mb-3 font-bold tracking-wide text-emerald-700">Coronary case review · AI research prototype</p>
              <h1 className="mb-4 max-w-2xl text-4xl leading-none font-extrabold md:text-5xl xl:text-6xl">
                Which coronary artery is at risk, before an invasive heart test?
              </h1>
              <p className="mb-6 max-w-2xl text-slate-700 md:text-lg lg:mb-8 lg:text-xl">
                NOVARION estimates coronary artery disease, and narrowing in each of the three main arteries (LAD, LCX
                and RCA), from routine clinical measurements. It shows the result on a 3D heart, with the reasons behind
                every prediction.
              </p>
              <button type="button" onClick={onSignIn} data-testid="landing-sign-in" className={`${primary} mr-3 px-5 py-3 text-base`}>
                Sign in
                <svg aria-hidden="true" className="-mr-1 ml-2 size-5" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
                  <path fillRule="evenodd" d={ARROW} clipRule="evenodd" />
                </svg>
              </button>
              <button type="button" onClick={() => scrollTo("landing-problem")}
                      className="inline-flex items-center justify-center rounded-lg border border-slate-300 px-5 py-3 text-base font-semibold text-slate-900 hover:bg-slate-100 focus:ring-4 focus:ring-slate-100">
                Read more
              </button>
            </div>
            <div className="mt-10 flex flex-col items-center lg:col-span-5 lg:mt-0">
              <LandingHeart onReviewCase={onSignIn} />
            </div>
          </div>
        </section>

        <section className="bg-white" aria-label="At a glance">
          <div className="mx-auto max-w-screen-xl px-4 pb-8 lg:pb-16">
            <dl className="grid grid-cols-2 gap-8 rounded-2xl bg-slate-50 p-6 sm:gap-12 lg:grid-cols-4">
              {FACTS.map(([value, label]) => (
                <div key={value} className="flex flex-col items-center text-center">
                  <dt className="order-2 mt-1 text-sm font-semibold text-slate-700">{label}</dt>
                  <dd className="text-3xl font-extrabold text-emerald-700 md:text-4xl">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section id="landing-problem" className="bg-slate-50" data-testid="landing-problem">
          <div className="mx-auto max-w-screen-xl px-4 py-8 sm:py-16 lg:px-6">
            <div className="mb-8 max-w-screen-md lg:mb-16">
              <p className="mb-2 font-bold text-emerald-700">The problem</p>
              <h2 className="mb-4 text-4xl font-extrabold">Coronary disease is common, and confirming it is invasive</h2>
              <p className="text-slate-700 sm:text-xl">
                Before an angiography, the doctor already holds a patient's history, ECG, echo and blood results. Weighing
                dozens of them by eye, for each artery separately, is hard, so many patients are sent for the invasive test to find out.
              </p>
            </div>
            <div className="space-y-8 md:grid md:grid-cols-2 md:gap-12 md:space-y-0 lg:grid-cols-3">
              {PROBLEM.map((p) => (
                <div key={p.title}>
                  <div className="mb-4 flex size-10 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 lg:size-12">
                    <Icon d={ICONS[p.icon]} />
                  </div>
                  <h3 className="mb-2 text-xl font-bold">{p.title}</h3>
                  <p className="text-slate-700">{p.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="landing-approach" className="bg-white" data-testid="landing-approach">
          <div className="mx-auto max-w-screen-xl items-center gap-16 px-4 py-8 lg:grid lg:grid-cols-2 lg:px-6 lg:py-16">
            <div className="text-slate-700 sm:text-lg">
              <p className="mb-2 font-bold text-emerald-700">Our approach</p>
              <h2 className="mb-4 text-4xl font-extrabold text-slate-900">An AI model that reads the routine record, artery by artery</h2>
              <p className="mb-4">
                We trained machine-learning models on the Z-Alizadeh Sani dataset: 303 patients who had an angiography,
                with 55 measurements taken before it and the angiography's answer for each artery.
              </p>
              <p>
                For a new patient, NOVARION gives the probability of CAD and of a significant narrowing in each artery,
                places it on that artery of the heart, and explains it, so the reviewer can check the reasoning instead
                of trusting a number.
              </p>
            </div>
            <ul className="mt-8 space-y-4 lg:mt-0">
              {APPROACH.map((a) => (
                <li key={a} className="flex gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 text-slate-800">
                  <span className="mt-0.5 shrink-0 text-emerald-700"><Icon d={ICONS.check} className="size-6" /></span>
                  <span>{a}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="landing-how" className="bg-slate-50" data-testid="landing-how">
          <div className="mx-auto max-w-screen-xl px-4 py-8 sm:py-16 lg:px-6">
            <div className="mb-8 max-w-screen-md lg:mb-16">
              <p className="mb-2 font-bold text-emerald-700">How it works</p>
              <h2 className="mb-4 text-4xl font-extrabold">From measurements to a heart you can read</h2>
            </div>
            <div className="space-y-8 md:grid md:grid-cols-3 md:gap-12 md:space-y-0">
              {STEPS.map((s) => (
                <div key={s.title}>
                  <div className="mb-4 flex size-10 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 lg:size-12">
                    <Icon d={ICONS[s.icon]} />
                  </div>
                  <h3 className="mb-2 text-xl font-bold">{s.title}</h3>
                  <p className="text-slate-700">{s.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="bg-white">
          <div className="mx-auto max-w-screen-xl px-4 py-8 lg:px-6 lg:py-16">
            <div className="max-w-screen-lg text-slate-700 sm:text-lg">
              <h2 className="mb-4 text-4xl font-bold text-slate-900">
                Decision support for review, <span className="font-extrabold">not a diagnosis</span>
              </h2>
              <p className="mb-4">
                NOVARION is an educational research prototype from the Multimodal AI Hackathon 2026 (Track A). It estimates
                the labels of one public dataset; it does not locate lesions or recommend tests or treatment, and it has
                not been validated outside that dataset.
              </p>
              <p className="font-semibold">
                Its measured accuracy, and where it is weaker, are shown inside the app on the Model evidence page.
              </p>
            </div>
          </div>
        </section>

        <section className="bg-slate-50">
          <div className="mx-auto max-w-screen-xl px-4 py-8 sm:py-16 lg:px-6">
            <div className="mx-auto max-w-screen-sm text-center">
              <h2 className="mb-4 text-4xl leading-tight font-extrabold">Review a case</h2>
              <p className="mb-6 text-slate-700 md:text-lg">Sign in with the account your administrator created for you.</p>
              <button type="button" onClick={onSignIn} data-testid="landing-sign-in-cta" className={`${primary} px-5 py-2.5 text-sm`}>
                Sign in
              </button>
            </div>
          </div>
        </section>
      </main>
      <DisclaimerFooter />
    </div>
  );
}
