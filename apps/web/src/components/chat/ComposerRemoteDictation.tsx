import { SmartphoneIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";

// Helm fork: stands in for the draft while Helm Mobile's remote listens for this thread. The
// words land at the end of the draft when the phone is done; typing waits until then.
export const ComposerRemoteDictation = memo(function ComposerRemoteDictation(props: {
  compact: boolean;
}) {
  return (
    <div
      data-chat-composer-remote-dictation="true"
      role="status"
      aria-live="polite"
      className={cn(
        "flex min-w-0 items-center gap-2.5 text-sm text-muted-foreground",
        props.compact ? "h-8 flex-1" : "min-h-16 px-4 py-3",
      )}
    >
      <span className="relative flex size-6 shrink-0 items-center justify-center">
        <span className="absolute inset-0 animate-ping rounded-full bg-primary/20" aria-hidden />
        <SmartphoneIcon className="relative size-4 text-primary" aria-hidden />
      </span>
      <span className="truncate">Speaking on your phone</span>
      <span className="flex items-center gap-1" aria-hidden>
        {[0, 160, 320].map((delay) => (
          <span
            key={delay}
            className="size-1 animate-pulse rounded-full bg-muted-foreground"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </span>
    </div>
  );
});
