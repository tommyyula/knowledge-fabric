import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface TooltipIconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label?: string;
  tooltip?: string;
  children?: ReactNode;
}

export const TooltipIconButton = forwardRef<HTMLButtonElement, TooltipIconButtonProps>(
  ({ label, tooltip, children, className, type = "button", ...props }, ref) => {
    const title = tooltip ?? label ?? props["aria-label"];
    return (
      <button
        ref={ref}
        type={type}
        {...props}
        title={title}
        aria-label={props["aria-label"] ?? title}
        className={cn("steward-action-icon", className)}
      >
        {children}
      </button>
    );
  },
);
TooltipIconButton.displayName = "TooltipIconButton";
