import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { SignIn } from "@/components/SignIn";

const Login = () => {
  const navigate = useNavigate();
  return <SignIn onSignedIn={() => void navigate({ to: "/" })} />;
};

export const Route = createFileRoute("/login")({ component: Login });
