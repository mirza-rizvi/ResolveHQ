import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes } from "react";
import { cn } from "@/web/lib/cn";

const buttonVariants = cva("button", {
  variants: { variant: { primary: "button-primary", secondary: "button-secondary", ghost: "button-ghost", danger: "button-danger" }, size: { default: "button-default", small: "button-small", icon: "button-icon" } },
  defaultVariants: { variant: "primary", size: "default" },
});

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> { asChild?: boolean }
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild, ...props }, ref) => {
  const Component = asChild ? Slot : "button";
  return <Component className={cn(buttonVariants({ variant, size }), className)} ref={ref} {...props} />;
});
Button.displayName = "Button";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => <input ref={ref} className={cn("input", className)} {...props} />);
Input.displayName = "Input";

export function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "green" | "amber" | "red" | "blue" | "violet" }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
