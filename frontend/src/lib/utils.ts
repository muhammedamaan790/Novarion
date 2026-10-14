// shadcn/ui's class-name helper: conditional classes, with later Tailwind utilities overriding earlier ones.
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
