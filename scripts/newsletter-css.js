module.exports = `
  :root {
    --green: #2EA84A;
    --mint: #7DE69B;
    --black: #25282A;
    --turquoise: #59BEC9;
    --coral: #E5554F;
    --yellow: #FFCD00;
    --dark-blue: #0D5F78;
    --deep-green: #1D4D52;
    --deep-blue: #1D4A5E;
    --off-white: #F5F4F2;
    --warm-bg: #FAFAF8;
    --light: #F8F7F5;
    --medium-gray: #999898;
    --dark-gray: #56595A;
    --border: #E2DFDB;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: 'Inter', Helvetica, Arial, sans-serif;
    color: var(--black);
    background: #E2DFDB;
    line-height: 1.65;
    -webkit-font-smoothing: antialiased;
  }

  .container {
    max-width: 780px;
    margin: 32px auto;
    background: #fff;
    overflow: hidden;
    box-shadow: 0 4px 40px rgba(0,0,0,0.12);
  }

  /* ═══ MASTHEAD (dark, compact) ═══ */
  .masthead {
    background: var(--black);
    padding: 14px 40px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .mast-left { display: flex; align-items: center; gap: 12px; }
  .pineapple { width: 28px; height: 28px; border-radius: 4px; overflow: hidden; flex-shrink: 0; }
  .pineapple svg { width: 28px; height: 28px; }
  .mast-name {
    font-family: 'Poppins', sans-serif;
    font-weight: 800;
    font-size: 14px;
    letter-spacing: 0.2em;
    color: #fff;
    line-height: 1;
  }
  .mast-right {
    text-align: right;
    font-size: 9px;
    color: var(--medium-gray);
    line-height: 1.4;
  }
  .mast-right .vol {
    font-family: 'Poppins', sans-serif;
    font-weight: 700;
    font-size: 8.5px;
    letter-spacing: 0.12em;
    color: var(--green);
  }

  /* ═══ GREEN RULE ═══ */
  .brand-rule { height: 3px; background: var(--green); }

  /* ═══ HERO (white, clean) ═══ */
  .hero {
    background: #fff;
    padding: 40px 40px 20px;
  }
  .hero-eyebrow {
    font-family: 'Poppins', sans-serif;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--green);
    margin-bottom: 14px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .hero-eyebrow::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--border);
  }
  .hero h1 {
    font-family: 'Poppins', sans-serif;
    font-size: 30px;
    font-weight: 800;
    color: var(--black);
    line-height: 1.15;
    max-width: 660px;
    margin-bottom: 0;
  }
  .hero h1 em {
    font-style: normal;
    color: var(--green);
  }

  /* ═══ EXEC SUMMARY (dark card, visually separate) ═══ */
  .exec-wrap {
    padding: 0 40px 36px;
    background: #fff;
  }
  .exec-box {
    background: var(--black);
    border-radius: 8px;
    padding: 26px 28px;
  }
  .exec-label {
    font-family: 'Poppins', sans-serif;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--mint);
    margin-bottom: 14px;
  }
  .exec-list { list-style: none; padding: 0; margin: 0; }
  .exec-list li {
    padding: 7px 0;
    font-size: 13px;
    color: rgba(255,255,255,0.7);
    line-height: 1.55;
    border-bottom: 1px solid rgba(255,255,255,0.06);
    display: flex;
    gap: 10px;
  }
  .exec-list li:last-child { border-bottom: none; }
  .exec-list li strong { color: #fff; }
  .exec-bullet {
    color: var(--green);
    font-weight: 700;
    font-size: 15px;
    flex-shrink: 0;
    line-height: 1.5;
  }

  /* ═══ STATS STRIP (dark) ═══ */
  .stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    background: var(--black);
  }
  .stat {
    padding: 20px;
    text-align: center;
    border-right: 1px solid rgba(255,255,255,0.06);
  }
  .stat:last-child { border-right: none; }
  .stat .num {
    font-family: 'Poppins', sans-serif;
    font-size: 24px;
    font-weight: 800;
    color: #fff;
  }
  .stat .lbl {
    font-size: 9px;
    font-weight: 500;
    color: rgba(255,255,255,0.4);
    letter-spacing: 0.03em;
    margin-top: 3px;
    line-height: 1.3;
  }

  /* ═══ TOC ═══ */
  .toc {
    padding: 14px 40px;
    background: var(--off-white);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .toc-label {
    font-family: 'Poppins', sans-serif;
    font-size: 7.5px;
    font-weight: 700;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--medium-gray);
    margin-right: 4px;
  }
  .toc a {
    font-size: 10.5px;
    font-weight: 600;
    color: var(--dark-gray);
    text-decoration: none;
    padding: 3px 10px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: #fff;
    transition: all 0.15s;
  }
  .toc a:hover { border-color: var(--green); color: var(--green); }

  /* ═══ SECTIONS ═══ */
  .section {
    padding: 44px 40px 40px;
    border-bottom: 1px solid var(--border);
    background: #fff;
  }
  .section.alt { background: var(--off-white); }

  .sec-head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 6px;
  }
  .sec-num {
    font-family: 'Poppins', sans-serif;
    font-size: 10px;
    font-weight: 700;
    color: #fff;
    background: var(--black);
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 5px;
    flex-shrink: 0;
  }
  .sec-tag {
    font-family: 'Poppins', sans-serif;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--medium-gray);
  }

  h2 {
    font-family: 'Poppins', sans-serif;
    font-size: 23px;
    font-weight: 800;
    color: var(--black);
    line-height: 1.2;
    margin-bottom: 6px;
  }
  .sec-intro {
    font-size: 14px;
    color: var(--dark-gray);
    margin-bottom: 20px;
    line-height: 1.55;
  }

  h3 {
    font-family: 'Poppins', sans-serif;
    font-size: 16px;
    font-weight: 700;
    color: var(--black);
    margin: 32px 0 10px;
    padding-top: 8px;
    line-height: 1.3;
  }

  p { font-size: 14px; color: var(--dark-gray); margin-bottom: 12px; }
  p:last-child { margin-bottom: 0; }
  strong { color: var(--black); }

  /* ═══ STORY CARDS ═══ */
  .story {
    margin: 18px 0;
    padding: 24px;
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 6px;
    border-left: 4px solid var(--green);
  }
  .alt .story { background: #fff; }
  .story.threat { border-left-color: var(--coral); }
  .story.watch { border-left-color: var(--yellow); }
  .story.opp { border-left-color: var(--turquoise); }

  .tag {
    font-family: 'Poppins', sans-serif;
    font-size: 8px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    display: inline-block;
    padding: 2px 8px;
    border-radius: 3px;
    margin-bottom: 8px;
  }
  .t-red { background: #FDECEB; color: var(--coral); }
  .t-yellow { background: #FFF8E1; color: #B8860B; }
  .t-blue { background: #E8F6F8; color: var(--dark-blue); }
  .t-gray { background: #F0EFED; color: var(--dark-gray); }

  .story h4 {
    font-family: 'Poppins', sans-serif;
    font-size: 15px;
    font-weight: 700;
    color: var(--black);
    margin-bottom: 8px;
    line-height: 1.3;
  }

  /* ═══ MARKETING IMPACT ═══ */
  .mi {
    margin-top: 14px;
    padding: 14px 16px;
    background: #f4f9f5;
    border-radius: 5px;
    border: 1px solid #d5edda;
  }
  .mi-label {
    font-family: 'Poppins', sans-serif;
    font-size: 8px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--green);
    margin-bottom: 6px;
  }
  .mi p { font-size: 12.5px; margin: 0; line-height: 1.55; color: var(--dark-gray) !important; }
  .mi strong { color: var(--black) !important; }

  /* ═══ IMPACT DOTS ═══ */
  .dots-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
  }
  .dots-label {
    font-family: 'Poppins', sans-serif;
    font-size: 8px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--medium-gray);
  }
  .dots { display: flex; gap: 3px; }
  .d { width: 10px; height: 10px; border-radius: 50%; background: var(--border); }
  .d.on { background: var(--coral); }

  /* ═══ SOURCES ═══ */
  .src {
    font-size: 10px !important;
    color: var(--medium-gray) !important;
    margin-top: 10px !important;
    padding-top: 8px;
    border-top: 1px solid var(--border);
  }
  .src a {
    color: var(--green);
    text-decoration: none;
    font-weight: 600;
    transition: color 0.15s;
  }
  .src a:hover { color: var(--dark-blue); text-decoration: underline; }

  /* ═══ CHARTS ═══ */
  .chart {
    background: var(--off-white);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 22px;
    margin: 18px 0;
  }
  .chart-title {
    font-family: 'Poppins', sans-serif;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--dark-gray);
    margin-bottom: 16px;
  }
  .bar-row {
    display: grid;
    grid-template-columns: 110px 1fr 55px;
    align-items: center;
    gap: 10px;
    margin: 7px 0;
  }
  .bar-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--black);
    text-align: right;
  }
  .bar-track {
    height: 20px;
    background: #E8E6E3;
    border-radius: 3px;
    overflow: hidden;
  }
  .bar-fill { height: 100%; border-radius: 3px; }
  .bar-val {
    font-family: 'Poppins', sans-serif;
    font-size: 12px;
    font-weight: 700;
    color: var(--black);
  }
  .chart-note {
    font-size: 9.5px !important;
    color: var(--medium-gray) !important;
    margin-top: 12px !important;
    font-style: italic;
  }

  /* ═══ METRIC CARDS ═══ */
  .metrics {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin: 20px 0;
  }
  .mc {
    padding: 20px;
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 6px;
    border-top: 3px solid var(--green);
  }
  .mc.red { border-top-color: var(--coral); }
  .mc.blue { border-top-color: var(--turquoise); }
  .mc.yellow { border-top-color: var(--yellow); }
  .mc .num {
    font-family: 'Poppins', sans-serif;
    font-size: 24px;
    font-weight: 800;
    color: var(--black);
    line-height: 1.1;
  }
  .mc .desc {
    font-size: 11.5px;
    color: var(--dark-gray);
    margin-top: 4px;
    line-height: 1.4;
  }

  /* ═══ TABLES ═══ */
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 16px 0;
    font-size: 12px;
  }
  thead th {
    font-family: 'Poppins', sans-serif;
    font-size: 8.5px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #fff;
    background: var(--black);
    text-align: left;
    padding: 10px 12px;
  }
  thead th:first-child { border-radius: 4px 0 0 0; }
  thead th:last-child { border-radius: 0 4px 0 0; }
  tbody td {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    color: var(--dark-gray);
    vertical-align: top;
  }
  tbody tr:nth-child(even) { background: var(--off-white); }
  .bdg {
    display: inline-block;
    font-family: 'Poppins', sans-serif;
    font-size: 8px;
    font-weight: 700;
    letter-spacing: 0.05em;
    padding: 2px 7px;
    border-radius: 3px;
  }
  .bdg-g { background: #E8F5E9; color: #2E7D32; }
  .bdg-b { background: #E3F2FD; color: #1565C0; }

  /* ═══ CALLOUTS ═══ */
  .callout {
    margin: 22px 0;
    padding: 20px 22px;
    background: var(--black);
    border-radius: 6px;
  }
  .cl {
    font-family: 'Poppins', sans-serif;
    font-size: 12px;
    font-weight: 700;
    color: var(--mint);
    margin-bottom: 6px;
  }
  .callout p { font-size: 13px; color: rgba(255,255,255,0.7); }
  .callout strong { color: #fff; }

  /* ═══ SECTION DARK (M&A) ═══ */
  .section-dark {
    padding: 44px 40px 40px;
    background: var(--black);
    border-bottom: 1px solid rgba(255,255,255,0.06);
  }
  .section-dark h2, .section-dark h3, .section-dark h4, .section-dark strong { color: #fff; }
  .section-dark p { color: rgba(255,255,255,0.65); }
  .section-dark .sec-tag { color: rgba(255,255,255,0.4); }
  .section-dark .sec-num { background: var(--green); }
  .section-dark .story { background: rgba(255,255,255,0.04); border-color: rgba(255,255,255,0.08); }
  .section-dark .story h4 { color: #fff; }
  .section-dark .callout { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08); }
  .section-dark .cl { color: var(--mint); }
  .section-dark .callout p { color: rgba(255,255,255,0.65); }
  .section-dark .callout strong { color: #fff; }
  .section-dark .chart { background: rgba(255,255,255,0.04); border-color: rgba(255,255,255,0.08); }
  .section-dark .chart-title { color: rgba(255,255,255,0.45); }
  .section-dark .bar-label { color: rgba(255,255,255,0.6); }
  .section-dark .bar-track { background: rgba(255,255,255,0.06); }
  .section-dark .bar-val { color: #fff; }

  /* ═══ INSIGHTS ═══ */
  .insight {
    display: flex;
    gap: 16px;
    padding: 18px 0;
    border-bottom: 1px solid var(--border);
  }
  .insight:last-child { border-bottom: none; }
  .i-num {
    font-family: 'Poppins', sans-serif;
    font-size: 13px;
    font-weight: 800;
    color: #fff;
    background: var(--black);
    min-width: 34px;
    height: 34px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    flex-shrink: 0;
  }
  .insight h4 { font-family: 'Poppins'; font-size: 13.5px; font-weight: 700; color: var(--black); margin-bottom: 4px; line-height: 1.3; }
  .insight p { font-size: 12.5px; margin: 0; line-height: 1.55; }

  /* ═══ BULLETS ═══ */
  ul.clean { list-style: none; padding: 0; margin: 8px 0; }
  ul.clean li {
    padding: 3px 0 3px 16px;
    position: relative;
    font-size: 13px;
    color: var(--dark-gray);
  }
  ul.clean li::before {
    content: "";
    position: absolute;
    left: 0;
    top: 11px;
    width: 5px;
    height: 5px;
    background: var(--green);
    border-radius: 50%;
  }

  /* ═══ DIVIDERS ═══ */
  .sep { height: 3px; background: var(--green); }

  /* ═══ FOOTER ═══ */
  .footer {
    background: var(--black);
    padding: 32px 40px;
    text-align: center;
  }
  .f-logo {
    font-family: 'Poppins';
    font-weight: 800;
    font-size: 12px;
    letter-spacing: 0.2em;
    color: #fff;
    margin-bottom: 2px;
  }
  .f-sub {
    font-size: 9px;
    color: var(--medium-gray);
    margin-bottom: 16px;
  }
  .f-sources {
    font-size: 8.5px;
    color: rgba(255,255,255,0.2);
    line-height: 1.8;
  }
  .f-badge {
    display: inline-block;
    margin-top: 14px;
    font-family: 'Poppins';
    font-size: 7.5px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--mint);
    border: 1px solid rgba(125,230,155,0.2);
    border-radius: 3px;
    padding: 4px 12px;
  }

  @media (max-width: 700px) {
    .container { margin: 0; }
    .masthead, .hero, .exec-wrap, .section, .section-dark, .toc, .footer { padding-left: 20px; padding-right: 20px; }
    .hero h1 { font-size: 24px; }
    .stats { grid-template-columns: 1fr 1fr; }
    .metrics { grid-template-columns: 1fr; }
    .bar-row { grid-template-columns: 80px 1fr 40px; }
  }
`;
