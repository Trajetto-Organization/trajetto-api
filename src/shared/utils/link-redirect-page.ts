function redirectPage(role: any) {
  const linkRedirectPage =
    role === "BUSINESS_USER" || role === "BUSINESS_ADMIN"
      ? "dashboard"
      : "admin";

  return linkRedirectPage;
}

export { redirectPage };
