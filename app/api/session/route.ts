import {
  authenticateUser,
  clearSession,
  createSession,
  getSessionUsername,
  isAuthenticated,
  registerUser,
} from "@/lib/operator-session";
import { NextResponse } from "next/server";

export async function GET() {
  const authenticated = await isAuthenticated();
  const username = authenticated ? await getSessionUsername() : null;

  return NextResponse.json({
    authenticated,
    username,
    operatorName: username,
  });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      username?: string;
      password?: string;
    };
    const result = await authenticateUser(body.username, body.password);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    await createSession(result.username);

    return NextResponse.json({
      authenticated: true,
      username: result.username,
      operatorName: result.username,
    });
  } catch (error) {
    console.error("POST /api/session failed", error);
    return NextResponse.json({ error: "登录失败，请稍后重试。" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as {
      username?: string;
      password?: string;
    };
    const result = await registerUser(body.username, body.password);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    await createSession(result.username);

    return NextResponse.json(
      {
        authenticated: true,
        username: result.username,
        operatorName: result.username,
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("PUT /api/session failed", error);
    return NextResponse.json({ error: "注册失败，请稍后重试。" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    await clearSession();
    return NextResponse.json({ authenticated: false });
  } catch (error) {
    console.error("DELETE /api/session failed", error);
    return NextResponse.json({ error: "退出登录失败，请稍后重试。" }, { status: 500 });
  }
}
