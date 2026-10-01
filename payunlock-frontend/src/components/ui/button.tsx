// Adapted from shadcn/ui (MIT); see licenses/shadcn-ui.txt.
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { LoaderCircle, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export const buttonVariants = cva("ui-button", {
  variants: { variant: { default: "ui-primary", secondary: "ui-secondary", outline: "ui-secondary", ghost: "ui-ghost", destructive: "ui-danger", link: "ui-link" }, size: { default: "", sm: "ui-small", lg: "ui-large", icon: "ui-icon-only" } },
  defaultVariants: { variant: "default", size: "default" },
});
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  icon?: LucideIcon;
  loading?: boolean;
  iconSpinning?: boolean;
}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild = false, icon: Icon, loading, iconSpinning, children, disabled, type = "button", ...props }, ref) => {
  const Comp = asChild ? Slot : "button";
  // asChild callers put their icon inside the link so Slot has exactly one child.
  return <Comp ref={ref} type={asChild ? undefined : type} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading || iconSpinning} aria-busy={loading || iconSpinning || undefined} {...props}>
    {asChild ? children : <>{loading ? <LoaderCircle className="button-icon spin" aria-hidden="true" /> : Icon && <Icon className={cn("button-icon", iconSpinning && "spin")} aria-hidden="true" />}{children}</>}
  </Comp>;
});
Button.displayName = "Button";
