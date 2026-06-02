import anthropic, os, requests

client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
token  = os.environ["GITHUB_TOKEN"]
repo   = os.environ["REPO"]
pr_num = os.environ["PR_NUMBER"]

with open("diff.txt") as f:
    diff = f.read()[:12000]

# Ask Claude to review and decide
msg = client.messages.create(
    model="claude-opus-4-5",
    max_tokens=1024,
    messages=[{
        "role": "user",
        "content": f"""You are a senior engineer reviewing a PR.
Review this diff and give concise feedback.

Rules for your decision:
- APPROVE if: code is correct, no bugs, no security issues, minor style comments are OK
- REQUEST_CHANGES only if: there is a real bug, security vulnerability, or broken logic

At the very end of your response, write either:
VERDICT: APPROVE
or
VERDICT: REQUEST_CHANGES

Diff:
{diff}"""
    }]
)

review = msg.content[0].text

# Extract verdict reliably from the last line
verdict = "REQUEST_CHANGES"
for line in review.splitlines():
    if "VERDICT: APPROVE" in line:
        verdict = "APPROVE"
        break
    elif "VERDICT: REQUEST_CHANGES" in line:
        verdict = "REQUEST_CHANGES"
        break

headers = {
    "Authorization": f"token {token}",
    "Accept": "application/vnd.github+json"
}

# Post comment with full review
requests.post(
    f"https://api.github.com/repos/{repo}/issues/{pr_num}/comments",
    headers=headers,
    json={"body": f"## Claude Code Review\n\n{review}"}
)

# Submit formal verdict
requests.post(
    f"https://api.github.com/repos/{repo}/pulls/{pr_num}/reviews",
    headers=headers,
    json={
        "event": verdict,
        "body": f"Claude verdict: {verdict}"
    }
)