import { createFileRoute } from '@tanstack/react-router'
import { About } from '../components/site/home/About'
import { Explore } from '../components/site/home/Explore'
import { Hero } from '../components/site/home/Hero'
import { pageTitle } from '../data/site'

export const Route = createFileRoute('/')({
  head: () => ({ meta: [{ title: pageTitle() }] }),
  component: HomePage,
})

function HomePage() {
  return (
    <>
      <Hero />
      <About />
      <Explore />
    </>
  )
}
