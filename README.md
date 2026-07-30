# k6 Performance Tests

This project contains performance and load tests written using **k6**.

## Prerequisites

Before running the tests, make sure the following tools are installed on your machine:

- Git
- Node.js (includes npm)
- k6
- A valid Bearer Token for API authentication

---




## 1. Install Node.js and npm

Download the LTS version from:

https://nodejs.org/

Verify the installation:

```powershell
node --version
npm --version
```

---

## 2. Install k6

### Windows (Chocolatey)

```powershell
choco install k6
```

### Windows (Winget)

```powershell
winget install k6
```

### macOS

```bash
brew install k6
```

### Linux (Ubuntu/Debian)

```bash
sudo gpg -k
sudo apt update
sudo apt install -y gnupg software-properties-common
curl -fsSL https://dl.k6.io/key.gpg | sudo gpg --dearmor -o /usr/share/keyrings/k6-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt update
sudo apt install k6
```

Verify the installation:

```powershell
k6 version
```

---

## 3. Clone the Repository

```powershell
git clone <repository-url>
cd k6-tests
```

Replace `<repository-url>` with your project's Git repository URL.

---

## 4. Install Project Dependencies

If the project uses npm packages, install them:

```powershell
npm install
```

---

## 5. Configure the Bearer Token

A valid Bearer Token is required to authenticate API requests.

### PowerShell

```powershell
$env:BEARER_TOKEN="your_bearer_token"
```

### Command Prompt

```cmd
set BEARER_TOKEN=your_bearer_token
```

### macOS/Linux

```bash
export BEARER_TOKEN="your_bearer_token"
```

---

## 6. Run the Tests

Run a specific test:

```powershell
k6 run tests/example.js
```

Or if your project uses npm scripts:

```powershell
npm test
```

or

```powershell
npm run load-test
```

---

## Project Structure

```
k6-tests/
│
├── tests/              # k6 test scripts
├── data/               # Test data
├── utils/              # Helper functions
├── package.json
├── README.md
└── .gitignore
```

---

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `BEARER_TOKEN` | API authentication token | Yes |

---

## Verify Your Setup

Run the following commands to confirm everything is installed correctly:

```powershell
git --version
node --version
npm --version
k6 version
```

If all commands return version information, your environment is ready.

---

## Troubleshooting

### k6 is not recognized

Restart your terminal after installation, or verify that the k6 executable is included in your system's `PATH`.

### Unauthorized (401)

- Ensure the Bearer Token is valid.
- Confirm the `BEARER_TOKEN` environment variable is set correctly.

### npm install fails

Delete `node_modules` and `package-lock.json`, then reinstall:

```powershell
Remove-Item -Recurse -Force node_modules
Remove-Item package-lock.json

npm install
```

---

## Useful Commands

```powershell
# Check versions
git --version
node --version
npm --version
k6 version

# Install dependencies
npm install

# Run a test
k6 run tests/example.js

# Run with environment variable
$env:BEARER_TOKEN="your_token"
k6 run tests/example.js
```
