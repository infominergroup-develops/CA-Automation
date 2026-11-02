import logo from '../assets/infominer-logo.png';

interface Props {
  size?: 'sm' | 'md' | 'lg';
  variant?: 'dark' | 'light';
  tagline?: string;
}

const HEIGHTS = { sm: 22, md: 30, lg: 42 };
const TAG = { sm: 'text-[9px]', md: 'text-[10px]', lg: 'text-xs' };

/**
 * Official Infominer logo. The artwork has dark lettering, so on dark backgrounds (variant="light")
 * it sits on a white chip to stay legible.
 */
export function InfominerLogo({ size = 'md', variant = 'dark', tagline }: Props) {
  const img = <img src={logo} alt="Infominer" style={{ height: HEIGHTS[size], width: 'auto' }} className="block select-none" draggable={false} />;
  return (
    <div className="inline-flex flex-col items-start gap-1">
      {variant === 'light' ? <span className="bg-white rounded-lg px-2.5 py-1.5 shadow-sm">{img}</span> : img}
      {tagline && (
        <span className={`font-medium tracking-wide uppercase ${TAG[size]} ${variant === 'light' ? 'text-slate-300' : 'text-slate-500'}`}>
          {tagline}
        </span>
      )}
    </div>
  );
}
