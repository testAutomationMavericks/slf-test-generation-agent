import anthropic, os, requests

client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
token  = os.environ["GITHUB_TOKEN"]
repo   = os.environ["REPO"]
pr_num = os.environ["PR_NUMBER"]

with open("diff.txt") as f:
    diff = f.read()[:12000]

# Ask Claude to review
msg = client.messages.create(
    model="claude-opus-4-5",
    max_tokens=1024,
    messages=[{
        "role": "user",
        "content": f"""You are a senior engineer reviewing a PR.
Review this diff and give concise feedback on:
- Bugs or logic errors
- Security issues
- Performance concerns
- Code quality

Diff:
{diff}

End with: APPROVE if ready to merge, or CHANGES NEEDED if not."""
    }]
)

review = msg.content[0].text
verdict = "APPROVE" if "APPROVE" in review else "REQUEST_CHANGES"

# Post review comment via GitHub API (no gh CLI needed)
headers = {
    "Authorization": f"token {token}",
    "Accept": "application/vnd.github+json"
}

# Post a comment
requests.post(
    f"https://api.github.com/repos/{repo}/issues/{pr_num}/comments",
    headers=headers,
    json={"body": f"## Claude Code Review\n\n{review}"}
)

# Submit a formal review (approve or request changes)
requests.post(
    f"https://api.github.com/repos/{repo}/pulls/{pr_num}/reviews",
    headers=headers,
    json={
        "event": verdict,
        "body": "Automated review by Claude"
    }
)
