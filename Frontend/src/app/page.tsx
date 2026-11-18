import ChatPage from "./chat/page";

/* Chat is the product's front door now: `/` renders the same experience as
   `/chat`, and the marketing landing page is gone. `/chat` stays in place so
   deep links that seed a prompt (`/chat?q=…`) keep working. */

export default function Home() {
  return <ChatPage />;
}
