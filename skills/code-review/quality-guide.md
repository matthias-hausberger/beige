# Code Quality Guide

## Naming Conventions

### Variables and Functions
- Use descriptive, intention-revealing names
- Prefer `getUserById` over `getData`
- Boolean variables should read naturally: `isValid`, `hasPermission`
- Avoid abbreviations unless universally understood

### Classes and Modules
- Nouns for classes: `UserRepository`, `PaymentProcessor`
- Verbs for functions: `calculateTotal`, `sendEmail`

## Code Structure

### Functions
- Single responsibility: one function, one job
- Small and focused (ideally under 20 lines)
- Minimal parameters (consider object for 4+ params)
- Pure functions preferred (no side effects)

### Error Handling
- Fail fast with meaningful error messages
- Use specific exception types
- Never catch and swallow silently
- Log errors with context

### Comments
- Explain *why*, not *what*
- Keep comments up-to-date with code
- Use TODO/FIXME consistently
- Prefer self-documenting code

## Testing Principles

- Test behavior, not implementation
- One assertion per test when possible
- Descriptive test names: `shouldReturnErrorWhenUserNotFound`
- Arrange-Act-Assert pattern
- Test edge cases and error paths

## Code Review Etiquette

### As Author
- Provide context in PR description
- Keep changes focused and reviewable
- Respond to feedback promptly
- Explain decisions when asked

### As Reviewer
- Be constructive and specific
- Ask questions instead of making demands
- Distinguish style preferences from issues
- Acknowledge good solutions
