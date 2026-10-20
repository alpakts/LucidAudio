import { ImageResponse } from "next/og";
import { AppIcon } from "@/lib/appIcon";

// Ana ekran simgeleri: /pwa-icon/192, /pwa-icon/512 ve kırpılabilir (maskable) /pwa-icon/512-maskable.
export const dynamic = "force-static";

export function generateStaticParams() {
  return [{ size: "192" }, { size: "512" }, { size: "512-maskable" }];
}

export async function GET(_req: Request, ctx: RouteContext<"/pwa-icon/[size]">) {
  const { size: param } = await ctx.params;
  const maskable = param.endsWith("-maskable");
  const size = Number.parseInt(param, 10);
  if (size !== 192 && size !== 512) return new Response("yok", { status: 404 });
  return new ImageResponse(<AppIcon size={size} pad={maskable ? 0.24 : 0.14} rounded={!maskable} />, {
    width: size,
    height: size,
  });
}
