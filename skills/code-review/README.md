# Code Review Skill

When reviewing code, systematically check for quality, security, and maintainability issues.

## Quick Checklist

- [ ] Code compiles and runs without errors
- [ ] Tests pass (if applicable)
- [ ] No hardcoded secrets or credentials
- [ ] Error handling is comprehensive
- [ ] Variable and function names are clear

## Security Review

See [security-checklist.md](./security-checklist.md) for detailed security items.

Key areas:
- Input validation on all user-provided data
- SQL injection prevention (parameterized queries)
- XSS prevention (proper escaping)
- Authentication and authorization checks
- Sensitive data handling

## Code Quality

See [quality-guide.md](./quality-guide.md) for style and best practices.

Focus on:
- Single responsibility principle
- DRY (Don't Repeat Yourself)
- Clear, self-documenting code
- Appropriate comments for complex logic
- Consistent formatting

## Review Process

1. **Understand the context** - What problem does this solve?
2. **Review the approach** - Is this the right solution?
3. **Check the implementation** - Are there bugs or issues?
4. **Consider edge cases** - What could go wrong?
5. **Suggest improvements** - How could this be better?

## Giving Feedback

- Be specific and constructive
- Explain *why* something is an issue
- Suggest concrete alternatives when possible
- Distinguish between blocking issues and suggestions
