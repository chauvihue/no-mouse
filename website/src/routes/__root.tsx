import { createRootRoute, HeadContent, Link, Outlet } from '@tanstack/react-router'
import { Backdrop, ScrollProgress } from '../components/site/Backdrop'
import { HandSvg } from '../components/site/HandSvg'
import { SiteFooter } from '../components/site/SiteFooter'
import { SiteNav } from '../components/site/SiteNav'
import { pageTitle, site } from '../data/site'
import { useScrollVars } from '../hooks/useScrollVars'

export const Route = createRootRoute({
  head: () => ({
    meta: [{ title: pageTitle() }, { name: 'description', content: site.metaDescription }],
  }),
  component: RootLayout,
  notFoundComponent: NotFound,
})

function RootLayout() {
  useScrollVars()
  return (
    <>
      <HeadContent />
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <ScrollProgress />
      <div className="site">
        <Backdrop />
        <SiteNav />
        <main id="main" className="site-main">
          <Outlet />
        </main>
        <SiteFooter />
      </div>
    </>
  )
}

function NotFound() {
  return (
    <section className="section not-found">
      <div className="container not-found__inner">
        <div className="not-found__art" aria-hidden="true">
          <div className="float">
            <HandSvg motion="index" />
          </div>
        </div>
        <p className="eyebrow">404</p>
        <h1 className="page-title">This page slipped off the strap.</h1>
        <p className="lede">The link may be old, or the page hasn’t been built yet.</p>
        <Link to="/" className="btn btn--primary">
          Back to home
        </Link>
      </div>
    </section>
  )
}
