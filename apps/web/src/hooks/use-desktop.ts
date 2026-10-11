import { useEffect, useState } from 'react';

export function useDesktop() {
  const [desktop, setDesktop] = useState(
    () => matchMedia('(min-width: 1024px)').matches,
  );
  useEffect(() => {
    const media = matchMedia('(min-width: 1024px)');
    const changed = () => setDesktop(media.matches);
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  return desktop;
}
