import type { SVGProps } from "react";

/**
 * One authored stroke set for the whole page: 24px grid, 1.8 stroke, round caps.
 * Icons are drawn here rather than borrowed from an emoji font so weight and
 * alignment stay consistent with the type.
 */

function Base(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    />
  );
}

export function IconCustomer(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <circle cx="12" cy="8" r="3.4" />
      <path d="M5.5 20c.6-3.6 3.3-5.6 6.5-5.6s5.9 2 6.5 5.6" />
    </Base>
  );
}

export function IconImage(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <rect x="3.2" y="4.8" width="17.6" height="14.4" rx="2.4" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="M4.4 17.2l4.6-4.3 3.4 3.1 3-2.7 4.2 3.9" />
    </Base>
  );
}

export function IconCheck(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M5 12.8l4.2 4.2L19 6.8" />
    </Base>
  );
}

export function IconSpark(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z" />
      <path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
    </Base>
  );
}

export function IconDownload(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M12 4v10.5" />
      <path d="M7.8 10.6L12 14.8l4.2-4.2" />
      <path d="M5 18.5h14" />
    </Base>
  );
}

export function IconRefresh(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.6-5.7" />
      <path d="M19.8 4.6v4.2h-4.2" />
    </Base>
  );
}

export function IconSwap(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M4.5 8.5h13" />
      <path d="M14.4 5.3l3.2 3.2-3.2 3.2" />
      <path d="M19.5 15.5h-13" />
      <path d="M9.6 12.3l-3.2 3.2 3.2 3.2" />
    </Base>
  );
}

export function IconUpload(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M12 16.5V6" />
      <path d="M7.8 10.2L12 6l4.2 4.2" />
      <path d="M5 19h14" />
    </Base>
  );
}

export function IconAlert(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 7.8v5" />
      <path d="M12 15.9h.01" />
    </Base>
  );
}

export function IconClock(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 7.4V12l3.2 2" />
    </Base>
  );
}

export function IconShare(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M12 15.5V4.2" />
      <path d="M8.1 8.1L12 4.2l3.9 3.9" />
      <path d="M5.2 13.4v4.9a1.8 1.8 0 0 0 1.8 1.8h10a1.8 1.8 0 0 0 1.8-1.8v-4.9" />
    </Base>
  );
}

export function IconNeedle(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M18.4 4.6L8.2 14.8" />
      <path d="M6.5 16.5l3.6 3.6 2.1-2.1-3.6-3.6z" />
      <path d="M17.6 3l3.4 3.4" />
    </Base>
  );
}
