"use client";

import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type CommonProps = {
  children: ReactNode;
  className?: string;
  icon?: ReactNode;
  variant?: "primary" | "secondary";
};

type LinkProps = CommonProps & { href: string; onClick?: never };
type ButtonProps = CommonProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof CommonProps> & { href?: never };

export function SquashButton(props: LinkProps | ButtonProps) {
  const { children, className = "", icon = "→", variant = "primary" } = props;
  const content = (
    <>
      <span className="squash-label">{children}</span>
      <span aria-hidden="true" className="squash-icon">
        {icon}
      </span>
    </>
  );
  const classes = `squash-button squash-${variant} ${className}`;

  if ("href" in props && props.href) {
    return (
      <Link className={classes} href={props.href}>
        {content}
      </Link>
    );
  }

  const { icon: _icon, variant: _variant, children: _children, className: _className, ...buttonProps } =
    props as ButtonProps;
  void _icon;
  void _variant;
  void _children;
  void _className;
  return (
    <button className={classes} type="button" {...buttonProps}>
      {content}
    </button>
  );
}
