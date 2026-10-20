"use client";

import { useEffect, useRef } from "react";

// Bir MediaStream'i <video> öğesine bağlar. Ses de bu öğeden çalar, bu yüzden kamera kapalıyken bile
// öğe DOM'da kalmalı (üstüne avatar bindirilir).
export function StreamVideo({
  stream,
  muted = false,
  mirror = false,
  fit = "cover",
  className = "",
  onDoubleClick,
  videoRef,
  sinkId,
}: {
  stream: MediaStream | null;
  muted?: boolean;
  mirror?: boolean;
  fit?: "cover" | "contain" | "responsive";
  className?: string;
  onDoubleClick?: () => void;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  sinkId?: string;
}) {
  const own = useRef<HTMLVideoElement>(null);
  const ref = videoRef ?? own;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    if (!stream) return;
    el.play().catch(() => {});
    // Parça değişince (kamera/mikrofon değişimi) bazı tarayıcılar yeni parçayı kendiliğinden göstermiyor.
    const rebind = () => {
      el.srcObject = null;
      el.srcObject = stream;
      el.play().catch(() => {});
    };
    stream.addEventListener("addtrack", rebind);
    return () => stream.removeEventListener("addtrack", rebind);
  }, [ref, stream]);

  useEffect(() => {
    const el = ref.current as (HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (!el?.setSinkId || muted) return;
    void el.setSinkId(sinkId ?? "").catch(() => {});
  }, [ref, sinkId, muted]);

  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      onDoubleClick={onDoubleClick}
      className={`${fit === "cover" ? "object-cover" : fit === "contain" ? "object-contain" : "object-cover sm:object-contain"} ${mirror ? "-scale-x-100" : ""} ${className}`}
    />
  );
}

export function toggleFullscreen(el: HTMLElement | null, video?: HTMLVideoElement | null) {
  if (!el) return;
  if (document.fullscreenElement) {
    void document.exitFullscreen();
    return;
  }
  if (el.requestFullscreen) {
    void el.requestFullscreen().catch(() => {});
    return;
  }
  // iOS Safari yalnızca <video> için tam ekran verir.
  const v = video as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null | undefined;
  v?.webkitEnterFullscreen?.();
}
