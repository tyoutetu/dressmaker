const ITEMS: Array<{ q: string; a: string }> = [
  {
    q: "What should I upload?",
    a: "A screenshot from Dressmaker showing the dress you made. A mannequin or finished-dress view works best, and front or three-quarter angles are easiest for the AI to read.",
  },
  {
    q: "Why does the preview look slightly different from my dress?",
    a: "The AI redraws the dress onto the customer, so small details can drift. If something important is missing — a bow, a colour, the sleeve shape — say so in the feedback box under the result. That is what we use to improve it.",
  },
  {
    q: "How many previews do I get?",
    a: "Up to three per day per network by default, and they refresh at 00:00 UTC. The limit is applied to your internet connection, not to this browser, so everyone on a shared Wi-Fi (home, dorm, café) shares it, and clearing your browser storage does not reset it. Sending a request counts as one attempt even if the connection or the AI provider fails afterwards.",
  },
  {
    q: "Do you store my screenshots?",
    a: "This app does not save the screenshot file you upload. To generate the preview, the screenshot is sent to the AI provider that creates it, and that provider handles the image under its own privacy policy. Feedback you type is stored so we can read it.",
  },
  {
    q: "Is this official?",
    a: "No. It is an unofficial, fan-made beta experiment. Dressmaker and its characters belong to their respective owners, and previews are not in-game results.",
  },
];

export function Faq() {
  return (
    <section className="step faq" aria-labelledby="faq-heading">
      <h2 id="faq-heading">Questions</h2>
      {ITEMS.map((item) => (
        <details key={item.q}>
          <summary>{item.q}</summary>
          <p>{item.a}</p>
        </details>
      ))}
      <p className="faq-note">
        This is an early beta. Anything here may change, and the previews can be paused at any time.
      </p>
    </section>
  );
}
