import { useQuery } from "@tanstack/react-query";
import * as Option from "effect/Option";
import { Component, createRef } from "react";
import { Problem } from "@/components/states";
import { FieldError } from "@/components/ui/field";
import { type TurnstileApi, signupQuery, turnstileQuery } from "@/lib/turnstile";

interface Props {
  /** Each fresh token, and `""` once it expired or the check failed. */
  readonly onToken: (token: string) => void;
}

interface WidgetProps extends Props {
  readonly turnstile: TurnstileApi;
  readonly siteKey: string;
}

/**
 * One widget, rendered into its container when mounted and removed with it, so it never outlives
 * the form (a stale one would still call back when its token expires).
 */
class Widget extends Component<WidgetProps, { readonly failure: Option.Option<string> }> {
  override state = { failure: Option.none<string>() };
  private readonly container = createRef<HTMLDivElement>();
  private widgetId = Option.none<string>();

  override componentDidMount() {
    const container = this.container.current;
    if (container === null) return;
    this.widgetId = Option.some(
      this.props.turnstile.render(container, {
        sitekey: this.props.siteKey,
        action: "signup",
        theme: "dark",
        callback: (token) => {
          this.setState({ failure: Option.none() });
          this.props.onToken(token);
        },
        "expired-callback": () => this.props.onToken(""),
        "error-callback": (code) => {
          this.setState({ failure: Option.some(code) });
          this.props.onToken("");
          return true;
        },
      }),
    );
  }

  override componentWillUnmount() {
    Option.map(this.widgetId, (id) => this.props.turnstile.remove(id));
  }

  override render() {
    return (
      <>
        <div className="min-h-[65px]" ref={this.container} />
        {Option.match(this.state.failure, {
          onNone: () => null,
          onSome: (code) => (
            <FieldError>The human check failed ({code}). Reload the page to try again.</FieldError>
          ),
        })}
      </>
    );
  }
}

const Loaded = ({
  scriptUrl,
  siteKey,
  onToken,
}: Props & { readonly scriptUrl: string; readonly siteKey: string }) => {
  const script = useQuery(turnstileQuery(scriptUrl));
  if (script.isError) return <Problem error={script.error} />;
  if (script.data === undefined) return <div className="min-h-[65px]" />;
  return <Widget turnstile={script.data} siteKey={siteKey} onToken={onToken} />;
};

/**
 * Cloudflare Turnstile at sign-up (PLAN.md §20.27). Tokens are single-use: remount it (a new
 * `key`) for each attempt to get another.
 */
export const HumanCheck = ({ onToken }: Props) => {
  const signup = useQuery(signupQuery);
  if (signup.isError) return <Problem error={signup.error} />;
  if (signup.data === undefined) return <div className="min-h-[65px]" />;
  return (
    <Loaded
      scriptUrl={signup.data.turnstile.scriptUrl}
      siteKey={signup.data.turnstile.siteKey}
      onToken={onToken}
    />
  );
};
