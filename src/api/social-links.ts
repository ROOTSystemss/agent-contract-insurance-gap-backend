// RootSystems social profiles, shown as icon links in every page footer. This list is the one place to change
// them: to add LinkedIn later, add { name: "LinkedIn", url: "https://www.linkedin.com/company/...", icon: "linkedin" }.
export const SOCIAL_LINKS: ReadonlyArray<{ name: string; url: string; icon: keyof typeof ICONS }> = [
  { name: "X", url: "https://x.com/TheROOTsystems", icon: "x" },
  { name: "Instagram", url: "https://www.instagram.com/therootsystemms/", icon: "instagram" },
];

const ICONS = {
  x: '<path fill="currentColor" d="M18.9 1.15h3.68l-8.04 9.19L24 22.85h-7.4l-5.8-7.58-6.64 7.58H.47l8.6-9.83L0 1.15h7.6l5.24 6.93zM17.6 20.64h2.04L6.48 3.24H4.3z"/>',
  instagram:
    '<g fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4.2"/></g><circle cx="17.6" cy="6.4" r="1.3" fill="currentColor"/>',
  linkedin:
    '<path fill="currentColor" d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.56V9h3.56zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z"/>',
} as const;

/** The footer's icon links: each opens the profile in a new tab (target="_blank", rel="noopener"). */
export function socialLinksHtml(links = SOCIAL_LINKS): string {
  const items = links.map(
    (l) =>
      `<a href="${l.url}" target="_blank" rel="noopener" aria-label="RootSystems on ${l.name}" title="${l.name}" style="display:inline-flex;color:inherit;opacity:.8">` +
      `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[l.icon]}</svg></a>`,
  );
  return `<span class="social-links" style="display:inline-flex;gap:10px;align-items:center;vertical-align:middle">${items.join("")}</span>`;
}

/** HTML pages carry a <!--social-links--> marker in their footer; it is replaced as the page is served. */
export const SOCIAL_LINKS_MARKER = "<!--social-links-->";
