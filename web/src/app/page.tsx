import { Chip, Nav, SectionCard, SquashButton } from "@/ui";
import { LiveHeroCard } from "@/ui/LiveHeroCard";

const steps = [
  {
    title: "Pick the field and tank",
    copy: "Choose one of ten Georgia cotton-county forecast points, then include one, two, or all three labels.",
    icon: "⌖",
  },
  {
    title: "Check the hourly forecast",
    copy: "Your browser fetches the National Weather Service forecast and passes its periods to the Rust planner.",
    icon: "☁",
  },
  {
    title: "Read the clause behind the hour",
    copy: "Every blocked hour and field check names the product, label page, exact quote, and reason.",
    icon: "≡",
  },
];

export default function HomePage() {
  return (
    <>
      <Nav />
      <main className="page-shell">
        <SectionCard className="hero-card" tone="field">
          <div className="hero-copy">
            <Chip icon="☁" tone="sun">
              Georgia cotton defoliation planner
            </Chip>
            <h1 className="display hero-title">Every label in the tank, checked against the forecast, one hour at a time.</h1>
            <p className="hero-lede">
              Labelhand checks typed rules from three EPA labels against the National Weather Service hourly forecast. It shows what the forecast can decide and what still needs a check in the field.
            </p>
            <div className="hero-actions">
              <SquashButton href="/app">Check a tank</SquashButton>
              <SquashButton href="/judge" icon="1-3" variant="secondary">
                Three-minute judge route
              </SquashButton>
            </div>
            <p className="hero-source">Sources shown in the planner: EPA Pesticide Product Label System and api.weather.gov.</p>
          </div>
          <LiveHeroCard />
        </SectionCard>

        <SectionCard className="steps-card" tone="sky">
          <div className="section-heading">
            <p className="hand">one forecast, every label</p>
            <h2 className="display">The short route from tank to hour</h2>
          </div>
          <ol className="home-steps">
            {steps.map((step, index) => (
              <li className="home-step" key={step.title}>
                <span aria-hidden="true" className="home-step-number display">
                  {index + 1}
                </span>
                <span aria-hidden="true" className="home-step-icon">
                  {step.icon}
                </span>
                <h3 className="display">{step.title}</h3>
                <p>{step.copy}</p>
              </li>
            ))}
          </ol>
        </SectionCard>
      </main>
    </>
  );
}
