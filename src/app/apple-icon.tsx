import { ImageResponse } from "next/og";
import { AppIcon } from "@/lib/appIcon";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// iOS köşeleri kendisi yuvarlar; tam kare ver.
export default function AppleIcon() {
  return new ImageResponse(<AppIcon size={180} pad={0.16} rounded={false} />, size);
}
