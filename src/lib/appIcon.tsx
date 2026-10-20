// Uygulama simgesi: koyu zemin üzerinde dört bölmeli açık mavi pencere.
// `pad` maskable simge için güvenli alan payı (Android simgeyi daire/yuvarlak kareye kırpar).
export function AppIcon({ size, pad = 0.2, rounded = true }: { size: number; pad?: number; rounded?: boolean }) {
  const inner = size * (1 - pad * 2);
  const gap = Math.max(1, Math.round(inner * 0.07));
  const pane = (inner - gap * 3) / 2;
  return (
    <div
      style={{
        width: size,
        height: size,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0b0d10",
        borderRadius: rounded ? size * 0.22 : 0,
      }}
    >
      <div
        style={{
          width: inner,
          height: inner,
          display: "flex",
          flexWrap: "wrap",
          gap,
          padding: gap,
          background: "#7cc4ff",
          borderRadius: inner * 0.18,
        }}
      >
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            style={{
              width: pane,
              height: pane,
              background: i === 1 ? "#d9eeff" : "#0b0d10",
              borderRadius: pane * 0.18,
            }}
          />
        ))}
      </div>
    </div>
  );
}
