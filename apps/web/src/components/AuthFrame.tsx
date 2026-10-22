import { AtSignIcon } from "lucide-react";
import type * as React from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** Signed-out screens: the wordmark over one centred card. */
export const AuthFrame = ({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: React.ReactNode;
  readonly children: React.ReactNode;
}) => (
  <main className="flex min-h-svh flex-col items-center justify-center gap-6 p-6">
    <div className="flex items-center gap-2">
      <AtSignIcon className="size-4 text-primary" aria-hidden />
      <span className="text-sm font-semibold tracking-tight">alias</span>
    </div>
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>
          <h1>{title}</h1>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  </main>
);
