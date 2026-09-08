// Render before the browser bundle loads so the unfinished UI never looks usable.
export const WORKSPACE_STARTUP_STYLE = `
body[data-workspace-loading]>:not(#workspace-startup),body[data-workspace-loading]>:not(#workspace-startup) *{visibility:hidden!important;pointer-events:none!important}
#workspace-startup{position:fixed;z-index:2147483647;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:28px;text-align:center;background:radial-gradient(ellipse at center,#131d2b 0%,#09090a 65%);color:#f2f2f3}
#workspace-startup .startup-mark{color:#7eb5f5;font:italic 700 84px/1 Georgia,serif;animation:workspace-breathe 1.8s ease-in-out infinite}
#workspace-startup h1{margin:8px 0 0;font-size:19px;font-weight:500}
#workspace-startup p{margin:0;max-width:440px;line-height:1.6;color:#92929b;overflow-wrap:anywhere}
#workspace-startup a{margin-top:10px;min-height:44px;display:inline-flex;align-items:center;padding:0 20px;border:1px solid #2d2d33;border-radius:10px;color:#7eb5f5;text-decoration:none}
#workspace-startup a:focus-visible{outline:2px solid #7eb5f5;outline-offset:3px}
body[data-workspace-loading="failed"] .startup-mark{animation:none!important}
@keyframes workspace-breathe{0%,100%{opacity:.4;transform:scale(.96)}50%{opacity:1;transform:scale(1)}}
@media(prefers-reduced-motion:reduce){#workspace-startup .startup-mark{animation:none}}
`;

export const WORKSPACE_STARTUP_HTML = `<section id="workspace-startup" aria-label="Opening workspace">
<div class="startup-mark" aria-hidden="true">π</div>
<h1 id="workspace-startup-title">Opening workspace…</h1>
<p id="workspace-startup-message" role="status" aria-live="polite">Loading the workspace interface…</p>
<a href="" aria-label="Retry opening workspace">Retry</a>
<noscript><p>Enable JavaScript to open this workspace.</p></noscript>
</section>`;
