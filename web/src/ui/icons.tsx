import type { ReactNode, SVGProps } from "react";

// width/height는 CSS(.chip svg 등)와 호출부 props가 언제든 덮어쓴다. 기본값을
// 두는 이유는 어떤 선택자와도 매칭되지 않은 아이콘이 SVG 기본 크기(300x150)로
// 부풀어 패널을 통째로 잡아먹는 사고를 구조적으로 막기 위해서다.
export function Icon({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {children}
    </svg>
  );
}

export const AlertIcon = () => <Icon><path d="M10.3 3.5 2.4 17.2A2 2 0 0 0 4.1 20h15.8a2 2 0 0 0 1.7-2.8L13.7 3.5a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></Icon>;
export const CalendarIcon = () => <Icon><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M8 3v4M16 3v4M3 10h18" /></Icon>;
export const MailIcon = () => <Icon><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m4 7 8 6 8-6" /></Icon>;
export const DriveIcon = () => <Icon><path d="M9 3h6l6 10-3 5H6l-3-5Z" /><path d="m9 3 6 10M21 13H9l-3 5" /></Icon>;
export const TrashIcon = () => <Icon><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6" /></Icon>;
export const RestoreIcon = () => <Icon><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></Icon>;
export const EditIcon = () => <Icon><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></Icon>;
export const AttachmentIcon = () => <Icon><path d="m21.4 11.6-8.9 8.9a6 6 0 0 1-8.5-8.5l9.6-9.6a4 4 0 0 1 5.7 5.7l-9.6 9.6a2 2 0 0 1-2.8-2.8l8.9-8.9" /></Icon>;
export const CloudIcon = () => <Icon><path d="M17.5 19H6a4 4 0 0 1-.5-8A6.5 6.5 0 0 1 18 9a5 5 0 0 1-.5 10Z" /><path d="m9 14 3-3 3 3M12 11v7" /></Icon>;
export const FolderIcon = () => <Icon><path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></Icon>;
export const FileIcon = () => <Icon><path d="M6 2h8l4 4v16H6Z" /><path d="M14 2v5h5" /></Icon>;
export const LocationIcon = () => <Icon><path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></Icon>;
export const TagIcon = () => <Icon><path d="M20 13 13 20l-9-9V4h7Z" /><circle cx="8.5" cy="8.5" r="1" /></Icon>;
export const InboxIcon = () => <Icon><path d="M4 4h16v16H4Z" /><path d="M4 14h5l2 3h2l2-3h5" /></Icon>;
export const StarIcon = () => <Icon><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z" /></Icon>;
export const SendIcon = () => <Icon><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></Icon>;
export const DraftIcon = () => <Icon><path d="M4 20h16M6 16l1-4L17 2l5 5-10 10Z" /></Icon>;
export const BanIcon = () => <Icon><circle cx="12" cy="12" r="9" /><path d="m5.6 5.6 12.8 12.8" /></Icon>;
export const ArchiveIcon = () => <Icon><path d="M4 7h16v14H4Z" /><path d="M3 3h18v4H3ZM9 12h6" /></Icon>;
export const VacationIcon = () => <Icon><path d="M3 20h18M5 17c3-5 5-9 7-13M8 8c-2-2-4-2-6-1M9 7c1-3 3-4 6-4M10 9c3-1 5 0 7 2" /></Icon>;
export const ClockIcon = () => <Icon><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Icon>;
export const CheckIcon = () => <Icon><path d="m5 12 4 4L19 6" /></Icon>;
export const SunIcon = () => <Icon><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Icon>;
export const MoonIcon = () => <Icon><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z" /></Icon>;
