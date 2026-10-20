// Sayfanın en altında küçük sürüm yazısı.
export function Version() {
  return (
    <p className="absolute inset-x-0 bottom-[max(0.75rem,env(safe-area-inset-bottom))] text-center text-[11px] font-mono text-muted/60 pointer-events-none select-none">
      Pencere v{process.env.NEXT_PUBLIC_APP_VERSION}
    </p>
  );
}
