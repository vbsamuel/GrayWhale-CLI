

# GrayWhale API CLI

A Command-Line Interface for interacting with the GrayWhale API.

## Project Description

This CLI tool allows you to create, list, get, and delete projects through the GrayWhale Hackathon API. It is designed to streamline the management of projects during the hackathon, providing a simple interface to the API for testing and automation purposes.

## Prerequisites

- **Node.js** v21 or higher (recommended for best compatibility)

## Installation

1. **Clone the repository:**
   ```bash
   git clone <repo-url>
   cd GeniusAPIDemo
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

## Environment Setup

Before using the CLI, create a `.env` file in the root of the project with the following variables:

```env
BASIC_USER=<your_basic_auth_username>
BASIC_PASS=<your_basic_auth_password>
BASE_URL=<base_url_of_the_hackathon_api>
```

Replace the values with your credentials and the API URL as provided for the hackathon.

## CLI Usage

Run the CLI using Node.js:

```bash
node graywhale_cli.mjs <command> [arguments]
```

### Commands

- **/create**

  Starts an interactive prompt to create a new project. You will be asked for:
    - `project_name`
    - `project_summary`

  **Note:** For the `project_summary`, you can enter multiple lines. Finish your input with an EOF sentinel (press `Ctrl+D` on Unix/Mac or `Ctrl+Z`, then `Enter` on Windows).

  **Example:**
  ```bash
  node graywhale_cli.mjs /create
  ```

- **/list**

  Lists all projects available to your account.

  **Example:**
  ```bash
  node graywhale_cli.mjs /list
  ```

- **/get <project_name>**

  Retrieves details for the specified project.

  **Example:**
  ```bash
  node graywhale_cli.mjs /get my_project
  ```


- **/delete <project_name>**

  Deletes the specified project.

  **Example:**
  ```bash
  node graywhale_cli.mjs /delete my_project
  ```

- **/token <project_name>**

  Request a new access token for a project (uses Basic auth).  
  The server will email the token to the project's registered `hacker_email`.

  **Example:**
  ```bash
  node graywhale_cli.mjs /token my_project
  ```

## Notes

- When entering the `project_summary` during `/create`, you can type multiple lines. End your input by sending EOF:
  - **On Unix/Mac:** Press `Ctrl+D`
  - **On Windows:** Press `Ctrl+Z`, then `Enter`

## Next Steps

- Implement seeding of items and further test the model endpoints.
- Expand the CLI to support additional API features as needed for the hackathon.

---

For questions or issues, please contact the project maintainers.